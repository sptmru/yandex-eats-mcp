import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { YandexEatsClient } from "../../src/eats/client.js";
import { createLogger } from "../../src/logger.js";
import { orderNumberFromRaw } from "../../src/orders/order-mapper.js";

const enabled = process.env.RUN_LIVE_EATS_ORDER_TESTS === "true";

describe.skipIf(!enabled)("live Yandex Eats order read-only contract", () => {
  it("lists orders and safely checks details/tracking when an order exists", async (context) => {
    const config = loadConfig(process.env);
    const client = new YandexEatsClient(config, createLogger("silent"));
    await client.initialize();

    const listed = await client.listOrders();
    expect(Array.isArray(listed.orders ?? [])).toBe(true);
    const activeOrderNrs = listed.update_settings?.order_nrs_to_update ?? [];
    const orderNr = activeOrderNrs.find((value) =>
      (listed.orders ?? []).map(orderNumberFromRaw).some((listedOrderNr) => listedOrderNr === value));
    if (!orderNr) {
      context.skip();
      return;
    }

    const details = await client.getOrderDetails(orderNr);
    const tracking = await client.getDesktopTracking(orderNr);
    expect(details).toBeTypeOf("object");
    expect(tracking).toBeTypeOf("object");
  });
});
