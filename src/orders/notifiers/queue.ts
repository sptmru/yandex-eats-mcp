import type { Logger } from "pino";
import type { OrderEvent } from "../types.js";
import type { OrderNotifier } from "./notifier.js";

type QueueEntry = { event: OrderEvent; attempt: number };

export class OrderNotifierQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  private stopped = false;
  private readonly delivered = new Set<string>();

  constructor(private readonly notifier: OrderNotifier, private readonly logger: Logger, private readonly maxSize = 100) {}

  enqueue(event: OrderEvent): void {
    if (this.stopped || this.notifier.provider === "none" || this.delivered.has(event.id)) return;
    if (this.queue.length >= this.maxSize) {
      const etaIndex = this.queue.findIndex((entry) => entry.event.type === "order.eta_changed");
      if (etaIndex >= 0) this.queue.splice(etaIndex, 1);
      else if (event.type === "order.eta_changed") return;
      else this.queue.shift();
    }
    this.queue.push({ event, attempt: 0 });
    void this.process();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const deadline = Date.now() + 5_000;
    while (this.processing && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const entry = this.queue.shift();
        if (!entry) continue;
        try {
          await this.notifier.send(entry.event);
          this.delivered.add(entry.event.id);
        } catch (_error) {
          entry.attempt += 1;
          this.logger.warn({ provider: this.notifier.provider, eventId: entry.event.id, attempt: entry.attempt }, "Order notification delivery failed");
          if (entry.attempt < 4 && !this.stopped) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 2 ** entry.attempt * 1_000)));
            this.queue.unshift(entry);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
