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
  listOrders(source?: string): Promise<RawOrdersEnvelope>;
  refreshOrders(orderNrs: string[]): Promise<RawOrdersEnvelope>;
  getDesktopTracking(orderNr: string): Promise<RawTrackingEnvelope>;
}

type TrackingController = { timer?: NodeJS.Timeout; inFlight: boolean };

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
      monitorHealthy: true,
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
  private listTimer: NodeJS.Timeout | undefined;
  private activeOrderNrs = new Set<string>();
  private tracking = new Map<string, TrackingController>();
  private terminalGraceRemaining = new Map<string, number>();
  private listIntervalMs: number;
  private lastFullDiscoveryAt = 0;
  private consecutiveFailures = 0;

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
    );
    this.listIntervalMs = config.orders.pollMaxMs;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async start(): Promise<void> {
    if (!this.config.orders.enabled || this.running) return;
    this.running = true;
    try {
      await this.pollNow();
    } catch (error) {
      await this.handlePollFailure(error);
    }
    if (this.running && !this.listTimer) this.scheduleList(this.nextErrorOrListDelay());
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.listTimer) clearTimeout(this.listTimer);
    this.listTimer = undefined;
    for (const controller of this.tracking.values()) {
      if (controller.timer) clearTimeout(controller.timer);
    }
    this.tracking.clear();
    this.terminalGraceRemaining.clear();
    await this.notifierQueue.stop();
    await this.store.flush();
  }

  wake(): void {
    if (!this.running) return;
    if (this.listTimer) clearTimeout(this.listTimer);
    this.listTimer = undefined;
    this.scheduleList(0);
  }

  async pollNow(): Promise<void> {
    const baseline = !this.store.isInitialized();
    const useRefresh = !baseline && this.activeOrderNrs.size > 0 &&
      Date.now() - this.lastFullDiscoveryAt < this.config.orders.pollMaxMs;
    const envelope = useRefresh
      ? await this.api.refreshOrders([...this.activeOrderNrs])
      : await this.api.listOrders();
    if (!useRefresh) this.lastFullDiscoveryAt = Date.now();
    await this.processOrdersEnvelope(envelope);
    if (baseline) {
      for (const orderNr of this.activeOrderNrs) await this.pollTracking(orderNr, true);
      await this.store.markInitialized();
      if (this.running) this.syncTrackingLoops();
    } else if (!this.running) {
      for (const orderNr of this.activeOrderNrs) await this.pollTracking(orderNr, false);
    }
    await this.markRecovered();
    this.consecutiveFailures = 0;
    await this.store.markPollSucceeded(new Date().toISOString());
  }

  getHealth(): OrderMonitorHealth {
    const lastSuccessfulPollAt = this.store.getLastSuccessfulPollAt();
    return {
      monitorEnabled: this.config.orders.enabled,
      monitorHealthy: !this.config.orders.enabled || (!this.store.getAuthExpired() && this.consecutiveFailures === 0),
      authExpired: this.store.getAuthExpired(),
      ...(lastSuccessfulPollAt ? { lastSuccessfulPollAt } : {}),
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
    }
    await this.store.pruneInactiveSnapshots(new Set([...this.activeOrderNrs, ...previousActive]));
    this.listIntervalMs = this.clampInterval((envelope.update_settings?.update_period ?? 10) * 1_000);
    if (this.running && this.store.isInitialized()) this.syncTrackingLoops();
  }

  private async pollTracking(orderNr: string, baseline: boolean): Promise<void> {
    const controller = this.tracking.get(orderNr);
    if (controller?.inFlight) return;
    if (controller) controller.inFlight = true;
    try {
      const envelope = await this.api.getDesktopTracking(orderNr);
      const status = normalizeOrderStatus(envelope.tracked_order, orderNr);
      if (status) await this.processStatus(status, baseline);
      await this.markRecovered();
      this.consecutiveFailures = 0;
      await this.store.markPollSucceeded(new Date().toISOString());
      if (this.running && !status?.terminal && this.shouldContinueTracking(orderNr)) {
        this.scheduleTracking(orderNr, this.clampInterval((envelope.polling_policy?.full_update_after ?? 10) * 1_000));
      } else if (status?.terminal) {
        this.removeTracking(orderNr);
      } else if (!this.activeOrderNrs.has(orderNr)) {
        this.removeTracking(orderNr);
      }
    } catch (error) {
      if (isTrackingNotFound(error)) {
        this.removeTracking(orderNr);
        this.logger.debug({ orderRef: orderNr.slice(-4) }, "Order is no longer available for desktop tracking");
        return;
      }
      await this.handlePollFailure(error);
      if (this.running && this.shouldContinueTracking(orderNr)) this.scheduleTracking(orderNr, this.nextErrorOrListDelay());
      else if (!this.activeOrderNrs.has(orderNr)) this.removeTracking(orderNr);
      if (!this.running) throw error;
    } finally {
      const current = this.tracking.get(orderNr);
      if (current) current.inFlight = false;
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
    const event = await this.store.commitEvent(input);
    if (!event) return undefined;
    this.notifierQueue.enqueue(event);
    this.logger.info(
      { eventId: event.id, eventType: event.type, orderRef: event.orderNr ? event.orderNr.slice(-4) : undefined },
      "Order monitor event recorded",
    );
    return event;
  }

  private syncTrackingLoops(): void {
    for (const orderNr of this.activeOrderNrs) {
      this.terminalGraceRemaining.delete(orderNr);
      if (!this.tracking.has(orderNr)) {
        this.tracking.set(orderNr, { inFlight: false });
        this.scheduleTracking(orderNr, 0);
      }
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
      void this.pollNow()
        .catch((error: unknown) => this.handlePollFailure(error))
        .finally(() => {
          if (this.running) this.scheduleList(this.nextErrorOrListDelay());
        });
    }, this.withJitter(delayMs));
    this.listTimer.unref();
  }

  private scheduleTracking(orderNr: string, delayMs: number): void {
    if (!this.running) return;
    const controller = this.tracking.get(orderNr) ?? { inFlight: false };
    if (controller.timer) clearTimeout(controller.timer);
    controller.timer = setTimeout(() => {
      delete controller.timer;
      void this.pollTracking(orderNr, false);
    }, this.withJitter(delayMs));
    controller.timer.unref();
    this.tracking.set(orderNr, controller);
  }

  private async handlePollFailure(error: unknown): Promise<void> {
    this.consecutiveFailures += 1;
    if (isAuthExpired(error) && !this.store.getAuthExpired()) {
      await this.store.setAuthExpired(true);
      await this.emitEvent({
        type: "monitor.auth_expired",
        summary: "Yandex Eats authentication expired. Refresh the cookie secret.",
      });
    }
    this.logger.warn(
      { errorCode: errorCode(error), consecutiveFailures: this.consecutiveFailures },
      "Order monitor poll failed",
    );
  }

  private async markRecovered(): Promise<void> {
    if (!this.store.getAuthExpired()) return;
    await this.store.setAuthExpired(false);
    await this.emitEvent({ type: "monitor.recovered", summary: "Yandex Eats order monitoring recovered." });
  }

  private nextErrorOrListDelay(): number {
    if (this.consecutiveFailures === 0) return this.listIntervalMs;
    return Math.min(this.config.orders.errorBackoffMaxMs, 10_000 * 2 ** Math.min(6, this.consecutiveFailures - 1));
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
