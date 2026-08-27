import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { YandexEatsClient } from "../../src/eats/client.js";
import { createLogger } from "../../src/logger.js";

const live = process.env.RUN_LIVE_EATS_TESTS === "true";

describe.runIf(live)("live Yandex Eats read-only contract", () => {
  it("checks authentication and performs a harmless search", async () => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      MCP_AUTH_MODE: "none",
      YANDEX_EATS_ENABLE_MUTATIONS: "false",
    });
    const client = new YandexEatsClient(config, createLogger("info"));
    await client.initialize();

    const authentication = await client.authStatus();
    expect(authentication.authenticated).toBe(true);
    const search = await client.search({ query: "пицца", maxPlaces: 3, maxItemsPerPlace: 2 });
    expect(search.places.length).toBeGreaterThan(0);
  });
});

