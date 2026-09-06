import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { EatsError } from "../src/mcp/errors.js";
import { OrderMonitor, type OrderApi } from "../src/orders/order-monitor.js";
import { NoopOrderNotifier } from "../src/orders/notifiers/notifier.js";
import { OrderNotifierQueue } from "../src/orders/notifiers/queue.js";
import type { RawOrdersEnvelope } from "../src/orders/upstream.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("OrderMonitor", () => {
  it("requires a successful poll in this process, including after restart", async () => {
    const directory = await temporaryDirectory();
    const monitor = createMonitor(directory, new SequenceOrderApi([emptyEnvelope()]));
    await monitor.initialize();
    expect(monitor.getHealth().monitorHealthy).toBe(false);
    await monitor.pollNow();
    expect(monitor.getHealth().monitorHealthy).toBe(true);
    const restarted = createMonitor(directory, new SequenceOrderApi([emptyEnvelope()]));
    await restarted.initialize();
    expect(restarted.getHealth()).toMatchObject({ monitorHealthy: false, listHealthy: false });
    await restarted.pollNow();
    expect(restarted.getHealth().monitorHealthy).toBe(true);
  });

  it("does not recover from tracking authentication failure just because the list succeeds", async () => {
    const directory = await temporaryDirectory();
    let trackingFails = true;
    const api = new SequenceOrderApi([ordersEnvelope("accepted")]);
    const tracking = api.getDesktopTracking.bind(api);
    api.getDesktopTracking = (orderNr) => trackingFails
      ? Promise.reject(new EatsError("AUTH_EXPIRED", "Expired")) : tracking(orderNr);
    const monitor = createMonitor(directory, api);
    await monitor.initialize();
    try {
      await monitor.start();
      expect(monitor.getHealth()).toMatchObject({
        monitorHealthy: false, listHealthy: true, trackingHealthy: false, authExpired: true,
      });
      await expect(monitor.pollNow()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
      expect(monitor.getEvents({}).events.map((event) => event.type)).toEqual(["monitor.auth_expired"]);
      expect(monitor.getHealth().lastSuccessfulPollAt).toBeUndefined();
      trackingFails = false;
      await monitor.pollNow();
      expect(monitor.getHealth()).toMatchObject({ monitorHealthy: true, authExpired: false });
      expect(monitor.getEvents({}).events.map((event) => event.type)).toEqual(["monitor.auth_expired", "monitor.recovered"]);
    } finally {
      await monitor.stop();
    }
  });

  it("keeps list failures unhealthy while individual tracking requests succeed", async () => {
    const directory = await temporaryDirectory();
    const api = new SequenceOrderApi([ordersEnvelope("accepted")]);
    const monitor = createMonitor(directory, api);
    await monitor.initialize();
    await monitor.pollNow();
    api.refreshOrders = () => Promise.reject(new EatsError("UPSTREAM_TIMEOUT", "Timed out"));
    await expect(monitor.pollNow()).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    await monitor.getOrderStatus("order-1234", true);
    expect(monitor.getHealth()).toMatchObject({ monitorHealthy: false, listHealthy: false, trackingHealthy: true });
  });

  it("requires every active tracking component to recover", async () => {
    const directory = await temporaryDirectory();
    let failing = true;
    const api: OrderApi = {
      listOrders: () => Promise.resolve({ update_settings: { order_nrs_to_update: ["one", "two"] } }),
      refreshOrders: () => Promise.resolve({ update_settings: { order_nrs_to_update: ["one", "two"] } }),
      getDesktopTracking: (orderNr) => orderNr === "two" && failing
        ? Promise.reject(new EatsError("AUTH_EXPIRED", "Expired"))
        : Promise.resolve({ tracked_order: { order_nr: orderNr, status: "preparing" } }),
    };
    const monitor = createMonitor(directory, api);
    await monitor.initialize();
    await expect(monitor.pollNow()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    await monitor.getOrderStatus("one", true);
    expect(monitor.getHealth()).toMatchObject({ monitorHealthy: false, trackingHealthy: false, authExpired: true });
    expect(monitor.getEvents({}).events.some((event) => event.type === "monitor.recovered")).toBe(false);
    failing = false;
    await monitor.getOrderStatus("two", true);
    expect(monitor.getHealth()).toMatchObject({ monitorHealthy: true, trackingHealthy: true, authExpired: false });
  });

  it("retries auth and recovery events after a failed journal append", async () => {
    const directory = await temporaryDirectory();
    let expired = false;
    const api = new SequenceOrderApi([emptyEnvelope()]);
    api.listOrders = () => expired ? Promise.reject(new EatsError("AUTH_EXPIRED", "Expired")) : Promise.resolve(emptyEnvelope());
    const monitor = createMonitor(directory, api);
    await monitor.initialize();
    await monitor.pollNow();
    const eventsPath = join(directory, "order-events.jsonl");
    for (const state of [true, false]) {
      expired = state;
      await rename(eventsPath, `${eventsPath}.backup`);
      await mkdir(eventsPath);
      await expect(monitor.pollNow()).rejects.toThrow();
      expect(monitor.getHealth().authExpired).toBe(true);
      expect(monitor.getEvents({}).events.map((event) => event.type)).toEqual(state ? [] : ["monitor.auth_expired"]);
      await rm(eventsPath, { recursive: true });
      await rename(`${eventsPath}.backup`, eventsPath);
      if (state) await expect(monitor.pollNow()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
      else await monitor.pollNow();
    }
    expect(monitor.getEvents({}).events.map((event) => event.type)).toEqual(["monitor.auth_expired", "monitor.recovered"]);
    expect(monitor.getHealth()).toMatchObject({ monitorHealthy: true, authExpired: false });
  });

  it("expires health when successful polls become stale", async () => {
    const directory = await temporaryDirectory();
    const monitor = createMonitor(directory, new SequenceOrderApi([ordersEnvelope("accepted")]));
    await monitor.initialize();
    await monitor.pollNow();
    const at = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(at + 120_001);
    expect(monitor.getHealth()).toMatchObject({ monitorHealthy: false, listHealthy: false, trackingHealthy: false });
    await monitor.getOrderStatus("order-1234", true);
    expect(monitor.getHealth()).toMatchObject({ monitorHealthy: false, listHealthy: false, trackingHealthy: true });
  });

  it("aborts and awaits in-flight startup work on stop without committing its late result", async () => {
    const directory = await temporaryDirectory();
    let signal: AbortSignal | undefined;
    const api: OrderApi = {
      listOrders: () => Promise.resolve(ordersEnvelope("accepted")),
      refreshOrders: () => Promise.resolve(ordersEnvelope("accepted")),
      getDesktopTracking: (_orderNr, requestSignal) => {
        signal = requestSignal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        });
      },
    };
    const monitor = createMonitor(directory, api);
    await monitor.initialize();
    const starting = monitor.start();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await monitor.stop();
    await starting;
    expect(signal?.aborted).toBe(true);
    expect(monitor.getHealth().monitorHealthy).toBe(false);
    expect(monitor.getEvents({}).events).toEqual([]);
  });

  it("uses the first snapshot as a baseline, then records one deduplicated status event", async () => {
    const directory = await temporaryDirectory();
    const api = new SequenceOrderApi([
      ordersEnvelope("accepted"),
      ordersEnvelope("preparing"),
      ordersEnvelope("preparing"),
    ]);
    const monitor = createMonitor(directory, api);
    await monitor.initialize();

    await monitor.pollNow();
    expect(monitor.getEvents({}).events).toEqual([]);

    await monitor.pollNow();
    await monitor.pollNow();

    const page = monitor.getEvents({ afterSequence: 0 });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ sequence: 1, type: "order.status_changed", orderNr: "order-1234" });
    expect(page.nextSequence).toBe(1);
    expect(monitor.getEvents({ afterSequence: page.nextSequence }).events).toEqual([]);
  });

  it("records a newly discovered order and preserves its cursor across restart", async () => {
    const directory = await temporaryDirectory();
    const firstApi = new SequenceOrderApi([emptyEnvelope(), ordersEnvelope("accepted")]);
    const first = createMonitor(directory, firstApi);
    await first.initialize();
    await first.pollNow();
    await first.pollNow();
    expect(first.getEvents({}).events).toHaveLength(1);

    const restarted = createMonitor(directory, new SequenceOrderApi([ordersEnvelope("accepted")]));
    await restarted.initialize();
    await restarted.pollNow();

    const events = restarted.getEvents({}).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sequence: 1, type: "order.discovered" });
  });

  it("classifies courier assignment and terminal transitions separately", async () => {
    const directory = await temporaryDirectory();
    const api = new SequenceOrderApi([
      ordersEnvelope("preparing"),
      ordersEnvelope("preparing", { courier: { name: "must-not-be-stored" } }),
      ordersEnvelope("delivered", { courier: { name: "must-not-be-stored" } }),
    ]);
    const monitor = createMonitor(directory, api);
    await monitor.initialize();
    await monitor.pollNow();
    await monitor.pollNow();
    await monitor.pollNow();

    expect(monitor.getEvents({}).events.map((event) => event.type)).toEqual([
      "order.courier_assigned",
      "order.terminal",
    ]);
    expect(JSON.stringify(monitor.getEvents({}).events)).not.toContain("must-not-be-stored");
  });

  it("does not treat historical orders as active when Yandex returns an empty update list", async () => {
    const directory = await temporaryDirectory();
    const historical = ordersEnvelope("delivered");
    const monitor = createMonitor(directory, new SequenceOrderApi([{ orders: historical.orders }]));
    await monitor.initialize();

    await monitor.pollNow();

    expect(monitor.getHealth().orders).toEqual([]);
    expect(monitor.getEvents({}).events).toEqual([]);
  });

  it("keeps desktop tracking authoritative when the orders list has different display text", async () => {
    const directory = await temporaryDirectory();
    let listCalls = 0;
    const api: OrderApi = {
      listOrders: () => {
        listCalls += 1;
        return Promise.resolve(listCalls === 1 ? emptyEnvelope() : ordersEnvelope("accepted", {
          title: { text: "Dish name from orders list" },
          subtitle: { text: "Order on map" },
        }));
      },
      refreshOrders: () => Promise.resolve(ordersEnvelope("accepted", {
        title: { text: "Dish name from orders list" },
        subtitle: { text: "Order on map" },
      })),
      getDesktopTracking: (orderNr) => Promise.resolve({
        tracked_order: {
          order_nr: orderNr,
          title: { text: "Arrives at 16:50-17:00" },
          subtitle: { text: "The food is being prepared" },
        },
        polling_policy: { full_update_after: 10 },
      }),
    };
    const monitor = createMonitor(directory, api);
    await monitor.initialize();

    await monitor.pollNow();
    await monitor.pollNow();
    await monitor.pollNow();
    await monitor.pollNow();

    const events = monitor.getEvents({}).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "order.discovered",
      current: { title: "Arrives at 16:50-17:00", subtitle: "The food is being prepared" },
    });
    expect(JSON.stringify(events)).not.toContain("Dish name from orders list");
  });

  it("classifies a title-only tracking change as ETA instead of status", async () => {
    const directory = await temporaryDirectory();
    const api = new SequenceOrderApi([
      ordersEnvelope("preparing", { title: { text: "Arrives at 16:50" }, subtitle: { text: "Preparing" } }),
      ordersEnvelope("preparing", { title: { text: "Arrives at 16:55" }, subtitle: { text: "Preparing" } }),
    ]);
    const monitor = createMonitor(directory, api);
    await monitor.initialize();
    await monitor.pollNow();
    await monitor.pollNow();

    expect(monitor.getEvents({}).events).toHaveLength(1);
    expect(monitor.getEvents({}).events[0]?.type).toBe("order.eta_changed");
  });
});

class SequenceOrderApi implements OrderApi {
  private index = 0;
  constructor(private readonly responses: RawOrdersEnvelope[]) {}

  listOrders() {
    return Promise.resolve(this.next());
  }

  refreshOrders() {
    return Promise.resolve(this.next());
  }

  getDesktopTracking(orderNr: string) {
    const current = this.responses[Math.max(0, this.index - 1)] ?? emptyEnvelope();
    const order = current.orders?.[0] ?? { order_nr: orderNr, status: "unknown" };
    return Promise.resolve({ tracked_order: order, polling_policy: { full_update_after: 10 } });
  }

  private next() {
    const response = this.responses[Math.min(this.index, this.responses.length - 1)] ?? emptyEnvelope();
    this.index += 1;
    return response;
  }
}

function createMonitor(directory: string, api: OrderApi): OrderMonitor {
  const config = loadConfig({
    NODE_ENV: "test",
    MCP_AUTH_MODE: "none",
    MCP_STATE_DIR: directory,
    YANDEX_EATS_ENABLE_ORDER_MONITORING: "true",
  });
  const logger = createLogger("silent");
  return new OrderMonitor(api, config, new OrderNotifierQueue(new NoopOrderNotifier(), logger), "none", logger, () => 0);
}

function ordersEnvelope(status: string, extra: Record<string, unknown> = {}) {
  return {
    orders: [{
      order_nr: "order-1234",
      status,
      title: { text: `Status ${status}` },
      progress_key: status,
      eta_text: "20 min",
      ...extra,
    }],
    update_settings: { update_period: 5, order_nrs_to_update: ["order-1234"] },
  };
}

function emptyEnvelope() {
  return { orders: [], update_settings: { update_period: 5, order_nrs_to_update: [] } };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yandex-eats-orders-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
