import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { OrderEvent } from "../types.js";
import type { OrderNotifier } from "./notifier.js";

export interface NotificationOutbox {
  getPendingNotifications(limit: number): OrderEvent[];
  acknowledgeNotification(event: OrderEvent): Promise<void>;
}

type QueueOptions = { sendTimeoutMs?: number; retryBaseMs?: number; retryMaxMs?: number };

export class OrderNotifierQueue {
  private outbox: NotificationOutbox | undefined;
  private task: Promise<void> | undefined;
  private shutdown = new AbortController();
  private started = false;
  private readonly sendTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(private readonly notifier: OrderNotifier, private readonly logger: Logger, options: QueueOptions = {}) {
    this.sendTimeoutMs = options.sendTimeoutMs ?? 10_000;
    this.retryBaseMs = options.retryBaseMs ?? 2_000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
  }

  attachOutbox(outbox: NotificationOutbox): void {
    this.outbox = outbox;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.shutdown = new AbortController();
    this.wake();
  }

  wake(): void {
    if (!this.started || this.task || this.notifier.provider === "none" || !this.outbox) return;
    this.task = this.process().catch(() => {
      this.logger.error({ provider: this.notifier.provider }, "Order notification worker failed");
    }).finally(() => {
      this.task = undefined;
      if (this.started && this.outbox?.getPendingNotifications(1).length) this.wake();
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.shutdown.abort();
    await this.task;
  }

  private async process(): Promise<void> {
    let attempt = 0;
    while (this.started && this.outbox) {
      const event = this.outbox.getPendingNotifications(1)[0];
      if (!event) return;
      try {
        await this.sendWithDeadline(event);
        // Telegram has no idempotency key: a crash after send but before this
        // durable acknowledgement can replay a message, never silently lose it.
        await this.outbox.acknowledgeNotification(event);
        attempt = 0;
      } catch (_error) {
        if (this.shutdown.signal.aborted) return;
        attempt += 1;
        this.logger.warn({ provider: this.notifier.provider, eventId: event.id, attempt }, "Order notification delivery failed");
        try {
          await delay(Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(attempt - 1, 8)), undefined, {
            signal: this.shutdown.signal,
          });
        } catch {
          return;
        }
      }
    }
  }

  private async sendWithDeadline(event: OrderEvent): Promise<void> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new Error("Order notification delivery timed out")), this.sendTimeoutMs);
    const signal = AbortSignal.any([this.shutdown.signal, deadline.signal]);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Order notification delivery aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // The race also bounds a notifier implementation that ignores AbortSignal.
      await Promise.race([this.notifier.send(event, signal), aborted]);
    } finally {
      clearTimeout(timeout);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
}
