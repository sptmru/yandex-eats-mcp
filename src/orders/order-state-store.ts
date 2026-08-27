import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { orderEventSchema, normalizedOrderStatusSchema, type NormalizedOrderStatus, type OrderEvent, type OrderEventType } from "./types.js";

type PersistedState = {
  version: 1;
  initialized: boolean;
  sequence: number;
  authExpired: boolean;
  lastSuccessfulPollAt?: string;
  snapshots: Record<string, NormalizedOrderStatus>;
};

const EMPTY_STATE: PersistedState = {
  version: 1,
  initialized: false,
  sequence: 0,
  authExpired: false,
  snapshots: {},
};

export class OrderStateStore {
  private readonly statePath: string;
  private readonly eventsPath: string;
  private state: PersistedState = structuredClone(EMPTY_STATE);
  private events: OrderEvent[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    stateDir: string,
    private readonly retentionDays: number,
    private readonly maxCount: number,
    private readonly logger: Logger,
  ) {
    this.statePath = join(stateDir, "order-monitor-state.json");
    this.eventsPath = join(stateDir, "order-events.jsonl");
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.statePath, ".."), { recursive: true });
    this.state = await this.loadState();
    this.events = await this.loadEvents();
    for (const event of this.events) {
      this.state.sequence = Math.max(this.state.sequence, event.sequence);
      if (event.current) this.state.snapshots[event.current.orderNr] = event.current;
    }
    await this.compactAndPersist();
  }

  isInitialized(): boolean {
    return this.state.initialized;
  }

  getSnapshot(orderNr: string): NormalizedOrderStatus | undefined {
    return this.state.snapshots[orderNr];
  }

  getSnapshots(): NormalizedOrderStatus[] {
    return Object.values(this.state.snapshots).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getAuthExpired(): boolean {
    return this.state.authExpired;
  }

  getLastSuccessfulPollAt(): string | undefined {
    return this.state.lastSuccessfulPollAt;
  }

  async markInitialized(): Promise<void> {
    await this.enqueue(async () => {
      this.state.initialized = true;
      await this.persistState();
    });
  }

  async setSnapshot(status: NormalizedOrderStatus): Promise<void> {
    await this.enqueue(async () => {
      this.state.snapshots[status.orderNr] = status;
      await this.persistState();
    });
  }

  async pruneInactiveSnapshots(activeOrderNrs: Set<string>): Promise<void> {
    await this.enqueue(async () => {
      let changed = false;
      for (const [orderNr, status] of Object.entries(this.state.snapshots)) {
        if (!activeOrderNrs.has(orderNr) && !status.terminal) {
          delete this.state.snapshots[orderNr];
          changed = true;
        }
      }
      if (changed) await this.persistState();
    });
  }

  async markPollSucceeded(at: string): Promise<void> {
    await this.enqueue(async () => {
      this.state.lastSuccessfulPollAt = at;
      await this.persistState();
    });
  }

  async setAuthExpired(value: boolean): Promise<void> {
    await this.enqueue(async () => {
      this.state.authExpired = value;
      await this.persistState();
    });
  }

  async commitEvent(input: {
    type: OrderEventType;
    summary: string;
    orderNr?: string;
    previous?: NormalizedOrderStatus;
    current?: NormalizedOrderStatus;
  }): Promise<OrderEvent | undefined> {
    let committed: OrderEvent | undefined;
    await this.enqueue(async () => {
      if (input.current && this.state.snapshots[input.current.orderNr]?.fingerprint === input.current.fingerprint) return;
      const event: OrderEvent = {
        id: randomUUID(),
        sequence: this.state.sequence + 1,
        occurredAt: new Date().toISOString(),
        type: input.type,
        ...(input.orderNr ? { orderNr: input.orderNr } : {}),
        ...(input.previous ? { previous: input.previous } : {}),
        ...(input.current ? { current: input.current } : {}),
        summary: input.summary,
      };
      await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      this.events.push(event);
      this.state.sequence = event.sequence;
      if (input.current) this.state.snapshots[input.current.orderNr] = input.current;
      await this.persistState();
      await this.compactIfNeeded();
      committed = event;
    });
    return committed;
  }

  getEvents(input: { afterSequence?: number; limit: number; orderNr?: string }): { events: OrderEvent[]; nextSequence: number; hasMore: boolean } {
    const filtered = this.events.filter((event) =>
      event.sequence > (input.afterSequence ?? 0) && (!input.orderNr || event.orderNr === input.orderNr));
    const events = filtered.slice(0, input.limit);
    return {
      events,
      nextSequence: events.at(-1)?.sequence ?? input.afterSequence ?? 0,
      hasMore: filtered.length > events.length,
    };
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async loadState(): Promise<PersistedState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      const record = asRecord(parsed);
      if (!record || record.version !== 1 || typeof record.initialized !== "boolean" || typeof record.sequence !== "number") {
        throw new Error("Invalid state shape");
      }
      const snapshots: Record<string, NormalizedOrderStatus> = {};
      const rawSnapshots = asRecord(record.snapshots) ?? {};
      for (const [orderNr, value] of Object.entries(rawSnapshots)) {
        const result = normalizedOrderStatusSchema.safeParse(value);
        if (result.success) snapshots[orderNr] = result.data;
      }
      return {
        version: 1,
        initialized: record.initialized,
        sequence: Math.max(0, Math.floor(record.sequence)),
        authExpired: record.authExpired === true,
        ...(typeof record.lastSuccessfulPollAt === "string" ? { lastSuccessfulPollAt: record.lastSuccessfulPollAt } : {}),
        snapshots,
      };
    } catch (error) {
      if (isMissingFile(error)) return structuredClone(EMPTY_STATE);
      const corruptPath = `${this.statePath}.corrupt-${Date.now()}`;
      await rename(this.statePath, corruptPath).catch(() => undefined);
      this.logger.warn({ stateFile: this.statePath, corruptFile: corruptPath }, "Order monitor state was corrupt and has been quarantined");
      return structuredClone(EMPTY_STATE);
    }
  }

  private async loadEvents(): Promise<OrderEvent[]> {
    try {
      const content = await readFile(this.eventsPath, "utf8");
      return content.split("\n").filter(Boolean).flatMap((line) => {
        try {
          const result = orderEventSchema.safeParse(JSON.parse(line) as unknown);
          return result.success ? [result.data] : [];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  private async compactAndPersist(): Promise<void> {
    this.pruneEvents();
    await this.rewriteEvents();
    await this.persistState();
  }

  private async compactIfNeeded(): Promise<void> {
    const before = this.events.length;
    this.pruneEvents();
    if (this.events.length !== before) await this.rewriteEvents();
  }

  private pruneEvents(): void {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    this.events = this.events.filter((event) => Date.parse(event.occurredAt) >= cutoff).slice(-this.maxCount);
  }

  private async persistState(): Promise<void> {
    await atomicWrite(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private async rewriteEvents(): Promise<void> {
    const content = this.events.map((event) => JSON.stringify(event)).join("\n");
    await atomicWrite(this.eventsPath, content ? `${content}\n` : "");
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
