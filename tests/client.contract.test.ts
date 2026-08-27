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
