import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { OrderMonitor, type OrderApi } from "../src/orders/order-monitor.js";
import { NoopOrderNotifier } from "../src/orders/notifiers/notifier.js";
import { OrderNotifierQueue } from "../src/orders/notifiers/queue.js";
import type { RawOrdersEnvelope } from "../src/orders/upstream.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("OrderMonitor", () => {
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
