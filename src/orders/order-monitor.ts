import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { YandexEatsClient } from "../eats/client.js";
import { EatsError } from "../mcp/errors.js";
import { normalizeOrderStatus, orderHasTrackingWidgets, orderNumberFromRaw } from "./order-mapper.js";
import { OrderStateStore } from "./order-state-store.js";
import type { RawOrdersEnvelope, RawTrackingEnvelope } from "./upstream.js";
import type { NormalizedOrderStatus, OrderEvent, OrderEventPage, OrderEventType, OrderMonitorHealth } from "./types.js";
import type { OrderNotifierQueue } from "./notifiers/queue.js";

export interface OrderApi {
  listOrders(source?: string, signal?: AbortSignal): Promise<RawOrdersEnvelope>;
  refreshOrders(orderNrs: string[], signal?: AbortSignal): Promise<RawOrdersEnvelope>;
  getDesktopTracking(orderNr: string, signal?: AbortSignal): Promise<RawTrackingEnvelope>;
}

type TrackingController = { timer?: NodeJS.Timeout };
type PollHealth = { lastSuccessAt?: number; failures: number; authExpired: boolean };
const emptyHealth = (): PollHealth => ({ failures: 0, authExpired: false });

export interface OrderMonitorService {
  getHealth(): OrderMonitorHealth;
  getNotifierProvider(): "none" | "telegram";
  getOrderStatus(orderNr: string, refresh?: boolean): Promise<NormalizedOrderStatus | undefined>;
  getEvents(input: { afterSequence?: number | undefined; limit?: number | undefined; orderNr?: string | undefined }): OrderEventPage;
}

export function createInactiveOrderMonitorService(config: AppConfig): OrderMonitorService {
  return {
    getHealth: () => ({
      monitorEnabled: config.orders.enabled,
      monitorHealthy: !config.orders.enabled,
      listHealthy: false,
      trackingHealthy: true,
      authExpired: false,
      orders: [],
    }),
    getNotifierProvider: () => "none",
    getOrderStatus: () => Promise.resolve(undefined),
    getEvents: (input) => ({ events: [], nextSequence: input.afterSequence ?? 0, hasMore: false }),
  };
}

export class OrderMonitor {
  private readonly store: OrderStateStore;
  private running = false;
  private stopped = false;
  private shutdown = new AbortController();
  private listTimer: NodeJS.Timeout | undefined;
  private listTask: Promise<void> | undefined;
  private trackingTasks = new Map<string, Promise<void>>();
  private activeOrderNrs = new Set<string>();
  private tracking = new Map<string, TrackingController>();
  private terminalGraceRemaining = new Map<string, number>();
  private listIntervalMs: number;
  private lastFullDiscoveryAt = 0;
  private listHealth: PollHealth = emptyHealth();
  private trackingHealth = new Map<string, PollHealth>();
  private healthUpdates: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: OrderApi,
    private readonly config: AppConfig,
    private readonly notifierQueue: OrderNotifierQueue,
    private readonly notifierProvider: "none" | "telegram",
    private readonly logger: Logger,
    private readonly random: () => number = Math.random,
  ) {
    this.store = new OrderStateStore(
      config.stateDir,
      config.orders.eventRetentionDays,
      config.orders.eventMaxCount,
      logger,
      notifierProvider,
    );
    this.listIntervalMs = config.orders.pollMaxMs;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    this.notifierQueue.attachOutbox(this.store);
  }

  async start(): Promise<void> {
    if (!this.config.orders.enabled || this.running) return;
    this.running = true;
    this.stopped = false;
    if (this.shutdown.signal.aborted) this.shutdown = new AbortController();
    this.notifierQueue.start();
    try {
      await this.pollNow();
    } catch (error) {
      // Each component records its own failure; list success cannot reset it.
      if (!this.stopped) this.logger.warn({ errorCode: errorCode(error) }, "Order monitor startup poll failed");
    }
    if (this.running && !this.listTimer) this.scheduleList(this.nextDelay(this.listHealth));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    this.shutdown.abort();
    if (this.listTimer) clearTimeout(this.listTimer);
    this.listTimer = undefined;
    for (const controller of this.tracking.values()) {
      if (controller.timer) clearTimeout(controller.timer);
    }
    await Promise.allSettled([this.listTask, ...this.trackingTasks.values(), this.notifierQueue.stop()]);
    this.tracking.clear();
    this.terminalGraceRemaining.clear();
    await this.healthUpdates;
    await this.store.flush();
  }

  wake(): void {
    if (!this.running) return;
    if (this.listTimer) clearTimeout(this.listTimer);
    this.listTimer = undefined;
    this.scheduleList(0);
    for (const orderNr of this.activeOrderNrs) this.scheduleTracking(orderNr, 0);
    this.notifierQueue.wake();
  }

  pollNow(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Order monitor is stopped"));
    this.listTask ??= this.pollList().finally(() => { this.listTask = undefined; });
    return this.listTask;
  }

  private async pollList(): Promise<void> {
    const baseline = !this.store.isInitialized();
    const firstPoll = this.listHealth.lastSuccessAt === undefined;
    const useRefresh = !baseline && this.activeOrderNrs.size > 0 &&
      Date.now() - this.lastFullDiscoveryAt < this.config.orders.pollMaxMs;
    try {
      const envelope = useRefresh
        ? await this.api.refreshOrders([...this.activeOrderNrs], this.shutdown.signal)
        : await this.api.listOrders(undefined, this.shutdown.signal);
      this.shutdown.signal.throwIfAborted();
      if (!useRefresh) this.lastFullDiscoveryAt = Date.now();
      await this.processOrdersEnvelope(envelope);
      this.listHealth = { lastSuccessAt: Date.now(), failures: 0, authExpired: false };
    } catch (error) {
      if (!this.shutdown.signal.aborted) await this.handlePollFailure(error, this.listHealth);
      throw error;
    }
    const results = baseline || firstPoll || !this.running
      ? await Promise.allSettled([...this.activeOrderNrs].map((orderNr) => this.pollTracking(orderNr, baseline)))
      : [];
    try {
      await this.reconcileHealth();
    } catch (error) {
      await this.handlePollFailure(error, this.listHealth);
      throw error;
    }
    if (this.running) this.syncTrackingLoops();
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  getHealth(): OrderMonitorHealth {
    const lastSuccessfulPollAt = this.store.getLastSuccessfulPollAt();
    const listHealthy = this.isFresh(this.listHealth);
    const trackingHealthy = this.requiredTrackingHealth().every((health) => this.isFresh(health));
    return {
      monitorEnabled: this.config.orders.enabled,
      monitorHealthy: !this.config.orders.enabled || (!this.stopped && this.store.isInitialized() &&
        !this.store.getAuthExpired() && listHealthy && trackingHealthy),
      listHealthy,
      trackingHealthy,
      authExpired: this.store.getAuthExpired() || this.listHealth.authExpired ||
        this.requiredTrackingHealth().some((health) => health.authExpired),
      ...(lastSuccessfulPollAt ? { lastSuccessfulPollAt } : {}),
      ...(this.listHealth.lastSuccessAt !== undefined
        ? { lastSuccessfulListPollAt: new Date(this.listHealth.lastSuccessAt).toISOString() } : {}),
      orders: this.store.getSnapshots().filter((order) => this.activeOrderNrs.has(order.orderNr) && !order.terminal),
    };
  }

  getNotifierProvider(): "none" | "telegram" {
    return this.notifierProvider;
  }

  async getOrderStatus(orderNr: string, refresh = false): Promise<NormalizedOrderStatus | undefined> {
    if (refresh) await this.pollTracking(orderNr, false);
    return this.store.getSnapshot(orderNr);
  }

  getEvents(input: { afterSequence?: number | undefined; limit?: number | undefined; orderNr?: string | undefined }): OrderEventPage {
    return this.store.getEvents({
      ...(input.afterSequence !== undefined ? { afterSequence: input.afterSequence } : {}),
      limit: Math.min(200, Math.max(1, input.limit ?? 50)),
      ...(input.orderNr ? { orderNr: input.orderNr } : {}),
    });
  }

  private async processOrdersEnvelope(envelope: RawOrdersEnvelope): Promise<void> {
    const previousActive = this.activeOrderNrs;
    const requested = envelope.update_settings?.order_nrs_to_update;
    const nextActive = new Set(requested ?? []);
    for (const raw of envelope.orders ?? []) {
      const orderNr = orderNumberFromRaw(raw);
      if (!orderNr) continue;
      if (orderHasTrackingWidgets(raw)) nextActive.add(orderNr);
    }
    this.activeOrderNrs = nextActive;
    for (const orderNr of [...this.activeOrderNrs]) {
      if (this.store.getSnapshot(orderNr)?.terminal) this.activeOrderNrs.delete(orderNr);
      else if (!this.trackingHealth.has(orderNr)) this.trackingHealth.set(orderNr, emptyHealth());
    }
    for (const orderNr of this.trackingHealth.keys()) {
      if (!this.activeOrderNrs.has(orderNr) && !this.tracking.has(orderNr)) this.trackingHealth.delete(orderNr);
    }
    await this.store.pruneInactiveSnapshots(new Set([...this.activeOrderNrs, ...previousActive]));
    this.listIntervalMs = this.clampInterval((envelope.update_settings?.update_period ?? 10) * 1_000);
  }

  private pollTracking(orderNr: string, baseline: boolean): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Order monitor is stopped"));
    const current = this.trackingTasks.get(orderNr);
    if (current) return current;
    const task = this.performTracking(orderNr, baseline).finally(() => { this.trackingTasks.delete(orderNr); });
    this.trackingTasks.set(orderNr, task);
    return task;
  }

  private async performTracking(orderNr: string, baseline: boolean): Promise<void> {
    const health = this.trackingHealth.get(orderNr) ?? emptyHealth();
    this.trackingHealth.set(orderNr, health);
    try {
      const envelope = await this.api.getDesktopTracking(orderNr, this.shutdown.signal);
      this.shutdown.signal.throwIfAborted();
      const status = normalizeOrderStatus(envelope.tracked_order, orderNr);
      if (!status) throw new EatsError("UPSTREAM_BAD_RESPONSE", "Desktop tracking did not contain an order status");
      await this.processStatus(status, baseline);
      Object.assign(health, { lastSuccessAt: Date.now(), failures: 0, authExpired: false });
      if (status.terminal) {
        this.activeOrderNrs.delete(orderNr);
        this.removeTracking(orderNr);
      } else if (this.running && this.shouldContinueTracking(orderNr)) {
        this.scheduleTracking(orderNr, this.clampInterval((envelope.polling_policy?.full_update_after ?? 10) * 1_000));
      } else if (!this.activeOrderNrs.has(orderNr)) {
        this.removeTracking(orderNr);
      }
      await this.reconcileHealth();
    } catch (error) {
      if (this.shutdown.signal.aborted) throw error;
      if (isTrackingNotFound(error)) {
        this.activeOrderNrs.delete(orderNr);
        this.removeTracking(orderNr);
        await this.reconcileHealth();
        this.logger.debug({ orderRef: orderNr.slice(-4) }, "Order is no longer available for desktop tracking");
        return;
      }
      await this.handlePollFailure(error, health);
      if (this.running && this.shouldContinueTracking(orderNr)) this.scheduleTracking(orderNr, this.nextDelay(health));
      else if (!this.activeOrderNrs.has(orderNr)) this.removeTracking(orderNr);
      throw error;
    }
  }

  private async processStatus(current: NormalizedOrderStatus, baseline: boolean): Promise<void> {
    const previous = this.store.getSnapshot(current.orderNr);
    if (!previous) {
      if (baseline) {
        await this.store.setSnapshot(current);
        return;
      }
      await this.emitEvent({
        type: "order.discovered",
        orderNr: current.orderNr,
        current,
        summary: `New active order detected${statusSuffix(current)}.`,
      });
      return;
    }
    if (previous.fingerprint === current.fingerprint) return;
    const type = classifyTransition(previous, current);
    await this.emitEvent({
      type,
      orderNr: current.orderNr,
      previous,
      current,
      summary: transitionSummary(type, current),
    });
  }

  private async emitEvent(input: {
    type: OrderEventType;
    summary: string;
    orderNr?: string;
    previous?: NormalizedOrderStatus;
    current?: NormalizedOrderStatus;
  }): Promise<OrderEvent | undefined> {
    try {
      const event = await this.store.commitEvent(input);
      if (!event) return undefined;
      this.logger.info(
        { eventId: event.id, eventType: event.type, orderRef: event.orderNr ? event.orderNr.slice(-4) : undefined },
        "Order monitor event recorded",
      );
      return event;
    } finally {
      // Also drain an append that succeeded before a later snapshot write failed.
      this.notifierQueue.wake();
    }
  }

  private syncTrackingLoops(): void {
    for (const orderNr of this.activeOrderNrs) {
      this.terminalGraceRemaining.delete(orderNr);
      if (!this.tracking.has(orderNr)) this.scheduleTracking(orderNr, 0);
    }
    for (const orderNr of this.tracking.keys()) {
      if (!this.activeOrderNrs.has(orderNr) && !this.terminalGraceRemaining.has(orderNr)) {
        this.terminalGraceRemaining.set(orderNr, 1);
        this.scheduleTracking(orderNr, 0);
      }
    }
  }

  private removeTracking(orderNr: string): void {
    const controller = this.tracking.get(orderNr);
    if (controller?.timer) clearTimeout(controller.timer);
    this.tracking.delete(orderNr);
    this.trackingHealth.delete(orderNr);
    this.terminalGraceRemaining.delete(orderNr);
  }

  private shouldContinueTracking(orderNr: string): boolean {
    if (this.activeOrderNrs.has(orderNr)) return true;
    const remaining = this.terminalGraceRemaining.get(orderNr) ?? 0;
    if (remaining <= 0) return false;
    this.terminalGraceRemaining.set(orderNr, remaining - 1);
    return true;
  }

  private scheduleList(delayMs: number): void {
    if (!this.running || this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = undefined;
      void this.pollNow().catch(() => {
        this.logger.debug("Scheduled order list poll failed");
      }).finally(() => {
        if (this.running) this.scheduleList(this.nextDelay(this.listHealth));
      });
    }, this.withJitter(delayMs));
    this.listTimer.unref();
  }

  private scheduleTracking(orderNr: string, delayMs: number): void {
    if (!this.running) return;
    const controller = this.tracking.get(orderNr) ?? {};
    if (controller.timer) clearTimeout(controller.timer);
    controller.timer = setTimeout(() => {
      delete controller.timer;
      void this.pollTracking(orderNr, !this.store.isInitialized()).catch(() => {
        this.logger.debug({ orderRef: orderNr.slice(-4) }, "Scheduled order tracking poll failed");
      });
    }, this.withJitter(delayMs));
    controller.timer.unref();
    this.tracking.set(orderNr, controller);
  }

  private async handlePollFailure(error: unknown, health: PollHealth): Promise<void> {
    health.failures += 1;
    health.authExpired ||= isAuthExpired(error);
    try {
      await this.reconcileHealth();
    } finally {
      this.logger.warn(
        { errorCode: errorCode(error), consecutiveFailures: health.failures },
        "Order monitor poll failed",
      );
    }
  }

  private reconcileHealth(): Promise<void> {
    const next = this.healthUpdates.then(async () => {
      if (this.stopped) return;
      const tracking = this.requiredTrackingHealth();
      const authExpired = this.listHealth.authExpired || tracking.some((health) => health.authExpired);
      if (authExpired && !this.store.getAuthExpired()) {
        await this.emitEvent({ type: "monitor.auth_expired", summary: "Yandex Eats authentication expired. Refresh the cookie secret." });
      }
      if (!this.isFresh(this.listHealth) || !tracking.every((health) => this.isFresh(health))) return;
      if (!this.store.isInitialized()) await this.store.markInitialized();
      if (this.store.getAuthExpired()) {
        await this.emitEvent({ type: "monitor.recovered", summary: "Yandex Eats order monitoring recovered." });
      }
      await this.store.markPollSucceeded(new Date().toISOString());
    });
    this.healthUpdates = next.catch(() => undefined);
    return next;
  }

  private requiredTrackingHealth(): PollHealth[] {
    return [...new Set([...this.activeOrderNrs, ...this.tracking.keys()])]
      .map((orderNr) => this.trackingHealth.get(orderNr) ?? emptyHealth());
  }

  private isFresh(health: PollHealth): boolean {
    const maxAge = Math.max(this.config.orders.pollMaxMs * 2, this.config.eats.timeoutMs * 2);
    return health.lastSuccessAt !== undefined && health.failures === 0 && !health.authExpired &&
      Date.now() - health.lastSuccessAt <= maxAge;
  }

  private nextDelay(health: PollHealth): number {
    if (health.failures === 0) return this.listIntervalMs;
    return Math.min(this.config.orders.errorBackoffMaxMs, 10_000 * 2 ** Math.min(6, health.failures - 1));
  }

  private clampInterval(value: number): number {
    return Math.min(this.config.orders.pollMaxMs, Math.max(this.config.orders.pollMinMs, Math.round(value)));
  }

  private withJitter(value: number): number {
    if (value <= 0) return 0;
    return Math.round(value * (1 + this.random() * 0.1));
  }
}

export function createOrderApi(client: YandexEatsClient): OrderApi {
  return client;
}

function classifyTransition(previous: NormalizedOrderStatus, current: NormalizedOrderStatus): OrderEventType {
  if (current.terminal && !previous.terminal) return "order.terminal";
  if (current.courierAssigned && !previous.courierAssigned) return "order.courier_assigned";
  const statusUnchanged = previous.phase === current.phase && previous.progressKey === current.progressKey &&
    previous.subtitle === current.subtitle;
  if (statusUnchanged && (previous.etaText !== current.etaText || previous.title !== current.title)) {
    return "order.eta_changed";
  }
  return "order.status_changed";
}

function transitionSummary(type: OrderEventType, current: NormalizedOrderStatus): string {
  if (type === "order.terminal") return `Order completed with status ${current.phase}.`;
  if (type === "order.courier_assigned") return "A courier was assigned to the order.";
  if (type === "order.eta_changed") return "The estimated delivery time changed.";
  return `Order status changed${statusSuffix(current)}.`;
}

function statusSuffix(status: NormalizedOrderStatus): string {
  if (status.phase !== "unknown") return `: ${status.phase}`;
  if (status.subtitle) return `: ${status.subtitle}`;
  if (status.title) return `: ${status.title}`;
  return "";
}

function isAuthExpired(error: unknown): boolean {
  return errorCode(error) === "AUTH_EXPIRED" || errorCode(error) === "AUTH_NOT_CONFIGURED";
}

function errorCode(error: unknown): string {
  if (error instanceof EatsError) return error.code;
  return "UNKNOWN";
}

function isTrackingNotFound(error: unknown): boolean {
  return error instanceof EatsError && error.code === "UPSTREAM_BAD_RESPONSE" && error.details?.status === 404;
}
