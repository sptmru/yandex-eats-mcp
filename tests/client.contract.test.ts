import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { YandexEatsClient } from "../src/eats/client.js";
import { createLogger } from "../src/logger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("YandexEatsClient HTTP contract", () => {
  it("sends the confirmed search payload and session headers", async () => {
    const directory = await temporaryDirectory();
    const cookieFile = join(directory, "cookie");
    await writeFile(cookieFile, "Session_id=session-value; webapitoken=web-api-value; baggage=trace-value");
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fakeFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: requestUrl(input), ...(init ? { init } : {}) });
      return Promise.resolve(jsonResponse({
        currency: { code: "AMD", sign: "֏" },
        pagination: { context: "opaque-next" },
        blocks: [
          {
            type: "places",
            payload: [
              {
                slug: "place-one",
                title: "Place One",
                business: "restaurant",
                available: true,
                items: [{ id: "42", title: "Lunch", decimal_price: "1200", adult: false }],
              },
            ],
          },
        ],
      }));
    });
    const client = new YandexEatsClient(
      testConfig(directory, cookieFile, false),
      createLogger("silent"),
      fakeFetch,
    );
    await client.initialize();

    const result = await client.search({ query: "lunch", cursor: "opaque-current" });

    expect(result.places[0]).toMatchObject({ placeSlug: "place-one", name: "Place One" });
    expect(result.cursor).toBe("opaque-next");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url.pathname).toBe("/eats/v1/full-text-search/v1/search");
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(typeof call?.init?.body === "string" ? call.init.body : "null")).toEqual({
      text: "lunch",
      location: { longitude: 44.51, latitude: 40.18 },
      pagination: { context: "opaque-current" },
    });
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer web-api-value");
    expect(headers.get("cookie")).toContain("Session_id=session-value");
    expect(headers.get("baggage")).toBe("trace-value");
    expect(headers.get("x-device-id")).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("blocks cart mutations before any upstream request when the feature flag is off", async () => {
    const directory = await temporaryDirectory();
    const cookieFile = join(directory, "cookie");
    await writeFile(cookieFile, "Session_id=session-value");
    const fakeFetch = vi.fn();
    const client = new YandexEatsClient(
      testConfig(directory, cookieFile, false),
      createLogger("silent"),
      fakeFetch as typeof fetch,
    );
    await client.initialize();

    await expect(
      client.addItems({
        placeSlug: "place-one",
        placeBusiness: "restaurant",
        operationId: "op-1",
        items: [{ itemId: "42", quantity: 1, options: [] }],
      }),
    ).rejects.toMatchObject({ code: "MUTATIONS_DISABLED" });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("wires all read-only order endpoints without exposing order numbers in the path", async () => {
    const directory = await temporaryDirectory();
    const cookieFile = join(directory, "cookie");
    await writeFile(cookieFile, "Session_id=session-value; webapitoken=web-api-value");
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fakeFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.pathname.endsWith("tracking-for-desktop")) {
        return Promise.resolve(jsonResponse({ tracked_order: { order_nr: "12345" }, polling_policy: { full_update_after: 7 } }));
      }
      if (url.pathname.endsWith("order-details")) {
        return Promise.resolve(jsonResponse({ order: { order_nr: "12345" }, update_settings: { period_s: 5 } }));
      }
      return Promise.resolve(jsonResponse({ orders: [], update_settings: { update_period: 10, order_nrs_to_update: [] } }));
    });
    const client = new YandexEatsClient(testConfig(directory, cookieFile, false), createLogger("silent"), fakeFetch);
    await client.initialize();

    await client.listOrders("history");
    await client.refreshOrders(["12345"]);
    await client.getOrderDetails("12345", { cursor: "opaque" });
    await client.getDesktopTracking("12345");

    expect(calls.map((call) => [call.init?.method, call.url.pathname])).toEqual([
      ["POST", "/eats/v1/orders-info/v1/orders"],
      ["POST", "/eats/v1/orders-info/v1/refresh-orders"],
      ["POST", "/eats/v1/orders-info/v1/desktop/order-details"],
      ["GET", "/eats/v1/eats-orders-tracking/v1/tracking-for-desktop"],
    ]);
    expect(JSON.parse(requestBody(calls[0]?.init?.body))).toEqual({ goods_items_limit: 6, source: "history" });
    expect(JSON.parse(requestBody(calls[1]?.init?.body))).toEqual({ order_nrs: ["12345"], goods_items_limit: 6 });
    expect(JSON.parse(requestBody(calls[2]?.init?.body))).toEqual({ order_nr: "12345", update_payload: { cursor: "opaque" } });
    expect(calls[3]?.url.searchParams.get("order_nr")).toBe("12345");
    expect(new Headers(calls[3]?.init?.headers).get("authorization")).toBe("Bearer web-api-value");
  });

  it("allows an adult menu item to be added to the cart", async () => {
    const directory = await temporaryDirectory();
    const cookieFile = join(directory, "cookie");
    await writeFile(cookieFile, "Session_id=session-value");
    let mutationBody: unknown;
    const fakeFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const pathname = requestUrl(input).pathname;
      if (pathname.includes("menu/retrieve")) {
        return Promise.resolve(jsonResponse({
          payload: {
            categories: [
              {
                id: 1,
                name: "Drinks",
                items: [
                  {
                    id: 77,
                    name: "Beer",
                    decimalPrice: "900",
                    available: true,
                    adult: true,
                    optionsGroups: [],
                  },
                ],
              },
            ],
          },
        }));
      }
      if (pathname.includes("full-carts")) {
        return Promise.resolve(jsonResponse({
          cart: { place_slug: "place-one", items: [], decimal_total: "0" },
        }));
      }
      if (pathname === "/api/v1/cart") {
        mutationBody = JSON.parse(typeof init?.body === "string" ? init.body : "null");
        return Promise.resolve(jsonResponse({ cart: {} }));
      }
      return Promise.reject(new Error(`Unexpected test request ${pathname}`));
    });
    const client = new YandexEatsClient(testConfig(directory, cookieFile, true), createLogger("silent"), fakeFetch);
    await client.initialize();

    await expect(client.addItems({
      placeSlug: "place-one",
      placeBusiness: "restaurant",
      operationId: "adult-item-operation",
      items: [{ itemId: "77", quantity: 1, options: [] }],
    })).resolves.toMatchObject({ operationId: "adult-item-operation" });
    expect(mutationBody).toMatchObject({ item_id: 77, quantity: 1, place_slug: "place-one" });
  });

  it("does not retry an ambiguous unsafe mutation", async () => {
    const directory = await temporaryDirectory();
    const cookieFile = join(directory, "cookie");
    await writeFile(cookieFile, "Session_id=session-value");
    let callNumber = 0;
    const fakeFetch = vi.fn((input: string | URL | Request) => {
      callNumber += 1;
      const pathname = requestUrl(input).pathname;
      if (pathname.includes("menu/retrieve")) {
        return Promise.resolve(jsonResponse({
          payload: {
            categories: [
              { id: 1, name: "Food", available: true, items: [{ id: 42, name: "Lunch", decimalPrice: "1200", available: true, adult: false, optionsGroups: [] }] },
            ],
          },
        }));
      }
      if (pathname.includes("full-carts")) {
        return Promise.resolve(jsonResponse({ cart: { place_slug: "place-one", items: [], decimal_total: "0" } }));
      }
      if (pathname === "/api/v1/cart") return Promise.reject(new DOMException("timed out", "TimeoutError"));
      return Promise.reject(new Error(`Unexpected test request ${pathname}`));
    });
    const client = new YandexEatsClient(
      testConfig(directory, cookieFile, true),
      createLogger("silent"),
      fakeFetch,
    );
    await client.initialize();

    await expect(
      client.addItems({
        placeSlug: "place-one",
        placeBusiness: "restaurant",
        operationId: "op-2",
        items: [{ itemId: "42", quantity: 1, options: [] }],
      }),
    ).rejects.toMatchObject({ code: "MUTATION_STATUS_UNKNOWN" });
    expect(callNumber).toBe(3);
    expect(fakeFetch.mock.calls.filter(([input]) => requestUrl(input).pathname === "/api/v1/cart")).toHaveLength(1);
  });

  it("deduplicates a repeated mutation operationId", async () => {
    const directory = await temporaryDirectory();
    const cookieFile = join(directory, "cookie");
    await writeFile(cookieFile, "Session_id=session-value");
    let fullCartLoads = 0;
    let mutationCalls = 0;
    const fakeFetch = vi.fn((input: string | URL | Request) => {
      const pathname = requestUrl(input).pathname;
      if (pathname.includes("menu/retrieve")) {
        return Promise.resolve(jsonResponse({
          payload: {
            categories: [
              { id: 1, name: "Food", items: [{ id: 42, name: "Lunch", decimalPrice: "1200", available: true, adult: false, optionsGroups: [] }] },
            ],
          },
        }));
      }
      if (pathname.includes("full-carts")) {
        fullCartLoads += 1;
        return Promise.resolve(jsonResponse({
          cart: {
            place_slug: "place-one",
            items: fullCartLoads === 1 ? [] : [{ id: "cart-1", item_id: 42, name: "Lunch", quantity: 1 }],
            decimal_total: fullCartLoads === 1 ? "0" : "1200",
          },
        }));
      }
      if (pathname === "/api/v1/cart") {
        mutationCalls += 1;
        return Promise.resolve(jsonResponse({ cart: {} }));
      }
      return Promise.reject(new Error(`Unexpected test request ${pathname}`));
    });
    const client = new YandexEatsClient(testConfig(directory, cookieFile, true), createLogger("silent"), fakeFetch);
    await client.initialize();
    const request = {
      placeSlug: "place-one",
      placeBusiness: "restaurant",
      operationId: "stable-operation",
      items: [{ itemId: "42", quantity: 1, options: [] }],
    };

    const first = await client.addItems(request);
    const second = await client.addItems(request);

    expect(second).toBe(first);
    expect(mutationCalls).toBe(1);
    expect(fullCartLoads).toBe(2);
  });
});

function testConfig(directory: string, cookieFile: string, mutationsEnabled: boolean) {
  return loadConfig({
    NODE_ENV: "test",
    MCP_AUTH_MODE: "none",
    MCP_STATE_DIR: directory,
    YANDEX_EATS_COOKIE_FILE: cookieFile,
    YANDEX_EATS_LATITUDE: "40.18",
    YANDEX_EATS_LONGITUDE: "44.51",
    YANDEX_EATS_ENABLE_MUTATIONS: String(mutationsEnabled),
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yandex-eats-mcp-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input.toString());
}

function requestBody(body: unknown): string {
  return typeof body === "string" ? body : "null";
}
