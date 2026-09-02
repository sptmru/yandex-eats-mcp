import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { YandexEatsClient } from "../../src/eats/client.js";
import { createLogger } from "../../src/logger.js";
import { FoodPreferenceStore } from "../../src/recommendations/preferences-store.js";
import { RecommendationService } from "../../src/recommendations/service.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("verifies recommendation candidates against current menus", async () => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      MCP_AUTH_MODE: "none",
      YANDEX_EATS_ENABLE_MUTATIONS: "false",
    });
    const logger = createLogger("info");
    const client = new YandexEatsClient(config, logger);
    await client.initialize();
    const stateDir = await mkdtemp(join(tmpdir(), "live-food-recommendations-"));
    try {
      const service = new RecommendationService(
        client,
        new FoodPreferenceStore(stateDir, logger),
        logger,
        { maxIntents: 3, maxMenus: 4, maxPagesPerQuery: 1, menuConcurrency: 2, menuCacheTtlMs: 60_000 },
      );
      const result = await service.recommend({
        query: "лёгкий обед: рыба, салат или суп",
        maxHeaviness: 0.75,
        maxPerRestaurant: 2,
        maxPerCategory: 2,
        limit: 5,
      });
      expect(result.menusLoaded).toBeGreaterThan(0);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.every((item) => item.matchedIntents.length > 0)).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
