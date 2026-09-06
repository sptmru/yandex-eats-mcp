import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { OrderStateStore } from "../src/orders/order-state-store.js";
import { OrderNotifierQueue } from "../src/orders/notifiers/queue.js";
import type { OrderNotifier } from "../src/orders/notifiers/notifier.js";

const directories: string[] = [];
const queues: OrderNotifierQueue[] = [];
const logger = createLogger("silent");

afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.stop()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable order notifications", () => {
  it("replays a committed event after restart even if no queue wake occurred, then persists its acknowledgement", async () => {
    const directory = await temporaryDirectory();
    const first = await createStore(directory);
    const event = await first.commitEvent({ type: "monitor.recovered", summary: "Recovered" });
    expect(event).toBeDefined();

    const restarted = await createStore(directory);
    const send = vi.fn<OrderNotifier["send"]>(() => Promise.resolve());
    const queue = createQueue(restarted, send);
    expect(send).not.toHaveBeenCalled();
    queue.start();
    await vi.waitFor(() => expect(restarted.getPendingNotifications(1)).toEqual([]), { interval: 5 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].id).toBe(event?.id);
    await queue.stop();

    const acknowledged = await createStore(directory);
    expect(acknowledged.getPendingNotifications(1)).toEqual([]);
    expect(acknowledged.getEvents({ limit: 10 }).events).toHaveLength(1);
  });

  it.each(["monitor.auth_expired", "monitor.recovered"] as const)("recovers the outbox and %s flag when snapshot persistence fails", async (type) => {
    const directory = await temporaryDirectory();
    const store = await createStore(directory);
    if (type === "monitor.recovered") await store.commitEvent({ type: "monitor.auth_expired", summary: "Expired" });
    const statePath = join(directory, "order-monitor-state.json");
    await rename(statePath, `${statePath}.backup`);
    await mkdir(statePath);
    await expect(store.commitEvent({ type, summary: "Committed in the journal" })).rejects.toThrow();
    await rm(statePath, { recursive: true });
    await rename(`${statePath}.backup`, statePath);

    const restarted = await createStore(directory);
    expect(restarted.getPendingNotifications(10)).toHaveLength(type === "monitor.recovered" ? 2 : 1);
    expect(restarted.getEvents({ limit: 10 }).events.at(-1)?.summary).toBe("Committed in the journal");
    expect(restarted.getAuthExpired()).toBe(type === "monitor.auth_expired");
  });

  it("retains pending deliveries beyond the event history count and age limits", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore(directory, 2);
    for (let index = 0; index < 4; index += 1) {
      await store.commitEvent({ type: "monitor.diagnostic", summary: `Pending ${index}` });
    }
    const eventsPath = join(directory, "order-events.jsonl");
    const oldJournal = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean).map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify({ ...event, occurredAt: "2000-01-01T00:00:00.000Z" });
    }).join("\n");
    await writeFile(eventsPath, `${oldJournal}\n`);
    const restarted = await createStore(directory, 2);
    expect(restarted.getPendingNotifications(10)).toHaveLength(4);
    for (const event of restarted.getPendingNotifications(10)) await restarted.acknowledgeNotification(event);
    expect(restarted.getPendingNotifications(10)).toEqual([]);
    expect((await createStore(directory, 2)).getPendingNotifications(10)).toEqual([]);
  });

  it("does not acknowledge in memory when acknowledgement persistence fails", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore(directory);
    const event = await store.commitEvent({ type: "monitor.recovered", summary: "Recovered" });
    const statePath = join(directory, "order-monitor-state.json");
    await rename(statePath, `${statePath}.backup`);
    await mkdir(statePath);
    await expect(store.acknowledgeNotification(event!)).rejects.toThrow();
    expect(store.getPendingNotifications(1)[0]?.id).toBe(event?.id);
    await rm(statePath, { recursive: true });
    await rename(`${statePath}.backup`, statePath);
    await store.acknowledgeNotification(event!);
    expect((await createStore(directory)).getPendingNotifications(1)).toEqual([]);
  });

  it("does not retroactively send events written with notifications disabled", async () => {
    const directory = await temporaryDirectory();
    const legacy = new OrderStateStore(directory, 30, 100, logger);
    await legacy.initialize();
    await legacy.commitEvent({ type: "monitor.recovered", summary: "Historical" });
    const enabled = await createStore(directory);
    expect(enabled.getPendingNotifications(10)).toEqual([]);
  });

  it("bounds a send that ignores cancellation and retries the durable event", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore(directory);
    await store.commitEvent({ type: "monitor.recovered", summary: "Recovered" });
    let firstSignal: AbortSignal | undefined;
    const send = vi.fn<OrderNotifier["send"]>()
      .mockImplementationOnce((_event, signal) => {
        firstSignal = signal;
        return new Promise(() => undefined);
      })
      .mockResolvedValue(undefined);
    const queue = createQueue(store, send);
    queue.start();
    await vi.waitFor(() => expect(store.getPendingNotifications(1)).toEqual([]), { interval: 5 });
    expect(firstSignal?.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("aborts an active send promptly on stop and retains it for the next process", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore(directory);
    await store.commitEvent({ type: "monitor.recovered", summary: "Recovered" });
    let requestSignal: AbortSignal | undefined;
    const send = vi.fn<OrderNotifier["send"]>((_event, signal) => {
      requestSignal = signal;
      return new Promise(() => undefined);
    });
    const queue = createQueue(store, send, 60_000);
    queue.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { interval: 5 });
    await queue.stop();
    expect(requestSignal?.aborted).toBe(true);
    expect((await createStore(directory)).getPendingNotifications(1)).toHaveLength(1);
  });

  it("cancels retry backoff during shutdown", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore(directory);
    await store.commitEvent({ type: "monitor.recovered", summary: "Recovered" });
    const send = vi.fn<OrderNotifier["send"]>(() => Promise.reject(new Error("Unavailable")));
    const queue = new OrderNotifierQueue({ provider: "telegram", send }, logger, { retryBaseMs: 60_000 });
    queues.push(queue);
    queue.attachOutbox(store);
    queue.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { interval: 5 });
    await queue.stop();
    expect(store.getPendingNotifications(1)).toHaveLength(1);
  });
});

function createQueue(store: OrderStateStore, send: OrderNotifier["send"], sendTimeoutMs = 20): OrderNotifierQueue {
  const queue = new OrderNotifierQueue({ provider: "telegram", send }, logger, { sendTimeoutMs, retryBaseMs: 5 });
  queue.attachOutbox(store);
  queues.push(queue);
  return queue;
}

async function createStore(directory: string, maxCount = 100): Promise<OrderStateStore> {
  const store = new OrderStateStore(directory, 30, maxCount, logger, "telegram");
  await store.initialize();
  return store;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yandex-eats-outbox-test-"));
  directories.push(directory);
  return directory;
}
