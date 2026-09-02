import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { YandexEatsClient } from "../src/eats/client.js";
import { diversifyResults } from "../src/recommendations/diversify.js";
import { expandSearchIntents } from "../src/recommendations/intents.js";
import { normalizeDish } from "../src/recommendations/normalize.js";
import { FoodPreferenceStore } from "../src/recommendations/preferences-store.js";
import { scoreCandidate } from "../src/recommendations/scoring.js";
import { RecommendationService } from "../src/recommendations/service.js";
import type { DishCandidate, FoodResult } from "../src/recommendations/types.js";
import { createLogger } from "../src/logger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("dish normalization", () => {
  it("recognizes Russian and English food attributes and estimates relative heaviness", () => {
    const light = normalizeDish({
      name: "Лосось на гриле с овощами",
      description: "Свежий салат и запечённые овощи",
      weight: "320 г",
    });
    const heavy = normalizeDish({
      name: "Crispy fried chicken pasta",
      description: "Creamy cheese sauce and bacon",
      weight: "650 g",
    });

    expect(light.categories).toEqual(expect.arrayContaining(["salad", "fish"]));
    expect(light.proteins).toContain("salmon");
    expect(light.cookingMethods).toEqual(expect.arrayContaining(["grilled", "baked"]));
    expect(heavy.fried).toBe(true);
    expect(heavy.creamy).toBe(true);
    expect(light.heaviness).toBeLessThan(heavy.heaviness);
    expect(heavy.heaviness).toBeGreaterThanOrEqual(0.8);
  });

  it("expands light and filling requests into several inspectable search intents", () => {
    expect(expandSearchIntents({ query: "something light but filling" })).toEqual([
      "bowl",
      "poke",
      "soup",
      "grilled fish",
      "salad",
      "chicken bowl",
    ]);
    expect(expandSearchIntents({ query: "лёгкий обед", categories: ["рыба", "салат"] })).toEqual(
      expect.arrayContaining(["рыба", "салат", "суп", "поке"]),
    );
  });

  it("does not classify tortellini as cake from a partial Russian word match", () => {
    expect(normalizeDish({ name: "Тортеллини с куриным бульоном" }).categories).toEqual(["soup"]);
  });
});

describe("recommendation scoring and diversification", () => {
  it("applies price, heaviness, avoid, and explicit preference signals", () => {
    const candidate = makeCandidate({
      itemId: "salmon",
      name: "Grilled salmon salad",
      price: 2500,
      normalized: normalizeDish({ name: "Grilled salmon salad" }),
      relevance: 0.9,
    });
    const liked = scoreCandidate(candidate, { query: "light fish", maxPrice: 3000, maxHeaviness: 0.6 }, [
      {
        placeSlug: candidate.placeSlug,
        itemId: candidate.itemId,
        liked: true,
        orderCount: 0,
        updatedAt: new Date().toISOString(),
      },
    ]);

    expect(liked?.scoreReasons).toEqual(expect.arrayContaining(["previously liked"]));
    expect(scoreCandidate(candidate, { query: "fish", maxPrice: 2000 }, [])).toBeUndefined();
    expect(scoreCandidate(candidate, { query: "fish", avoid: ["salmon"] }, [])).toBeUndefined();
  });

  it("honors category and restaurant quotas while retaining strong results", () => {
    const results = [
      makeResult("r1", "fish-1", "fish", 0.99),
      makeResult("r1", "fish-2", "fish", 0.98),
      makeResult("r2", "fish-3", "fish", 0.97),
      makeResult("r2", "soup-1", "soup", 0.9),
      makeResult("r3", "salad-1", "salad", 0.88),
    ];
    const selected = diversifyResults(results, {
      limit: 4,
      maxPerRestaurant: 1,
      maxPerCategory: 2,
      exploration: 0.7,
    });

    expect(selected).toHaveLength(3);
    expect(new Set(selected.map((entry) => entry.placeSlug)).size).toBe(3);
    expect(selected.filter((entry) => entry.normalized.categories.includes("fish"))).toHaveLength(1);
  });
});

describe("preference persistence", () => {
  it("persists and aggregates explicit feedback under the state directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "food-preferences-"));
    temporaryDirectories.push(directory);
    const logger = createLogger("silent");
    const store = new FoodPreferenceStore(directory, logger);
    await store.record({ placeSlug: "cafe", itemId: "dish", signal: "liked" });
    await store.record({ placeSlug: "cafe", itemId: "dish", signal: "ordered", orderedAt: "2026-09-01T12:00:00.000Z" });
    await store.record({ placeSlug: "cafe", itemId: "dish", signal: "rated", rating: 5 });

    const reloaded = new FoodPreferenceStore(directory, logger);
    expect(await reloaded.list()).toEqual([
      expect.objectContaining({
        placeSlug: "cafe",
        itemId: "dish",
        liked: true,
        rating: 5,
        orderCount: 1,
        lastOrderedAt: "2026-09-01T12:00:00.000Z",
      }),
    ]);
  });
});

describe("recommendation orchestration", () => {
  it("deduplicates places, verifies full menus, and excludes restaurant-only false positives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recommendation-service-"));
    temporaryDirectories.push(directory);
    const search = vi.fn().mockResolvedValue({
      query: "fish",
      currency: "AMD",
      places: [
        {
          placeSlug: "sea",
          name: "Sea",
          business: "restaurant",
          available: true,
          rating: "4.8",
          promos: [],
          items: [{ itemId: "1", name: "Salmon", price: 3000, currency: "AMD", adult: false, hasRequiredOptions: false }],
        },
        {
          placeSlug: "fish-name-only",
          name: "Fish House",
          business: "restaurant",
          available: true,
          promos: [],
          items: [],
        },
      ],
    });
    const getMenu = vi.fn(({ placeSlug }: { placeSlug: string }) => Promise.resolve({
      placeSlug,
      currency: "AMD",
      categories: [{
        categoryId: "main",
        name: "Main",
        available: true,
        categories: [],
        items: placeSlug === "sea"
          ? [{
              itemId: "1",
              name: "Grilled salmon",
              description: "Fish with vegetables",
              price: 3000,
              currency: "AMD",
              available: true,
              adult: false,
              optionGroups: [],
            }]
          : [{
              itemId: "2",
              name: "Beef burger",
              price: 2500,
              currency: "AMD",
              available: true,
              adult: false,
              optionGroups: [],
            }],
      }],
    }));
    const client = { search, getMenu } as unknown as YandexEatsClient;
    const service = new RecommendationService(
      client,
      new FoodPreferenceStore(directory, createLogger("silent")),
      createLogger("silent"),
      { maxIntents: 6, maxMenus: 10, maxPagesPerQuery: 1, menuConcurrency: 2, menuCacheTtlMs: 60_000 },
    );

    const result = await service.searchItems({ queries: ["fish", "seafood", "fish"], maxItems: 10 });
    expect(search).toHaveBeenCalledTimes(2);
    expect(getMenu).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      placeSlug: "sea",
      itemId: "1",
      matchedIntents: ["fish", "seafood"],
    });
  });
});

function makeCandidate(overrides: Partial<DishCandidate> = {}): DishCandidate {
  return {
    placeSlug: "place",
    placeName: "Place",
    placeBusiness: "restaurant",
    rating: 4.8,
    promos: [],
    itemId: "item",
    name: "Dish",
    price: 1000,
    currency: "AMD",
    adult: false,
    hasRequiredOptions: false,
    menuCategories: ["Main"],
    normalized: normalizeDish({ name: "Dish" }),
    matchedIntents: ["dish"],
    relevance: 0.8,
    ...overrides,
  };
}

function makeResult(placeSlug: string, itemId: string, category: string, score: number): FoodResult {
  const candidate = makeCandidate({
    placeSlug,
    itemId,
    name: itemId,
    normalized: { ...normalizeDish({ name: itemId }), categories: [category] },
  });
  const { relevance, ...withoutRelevance } = candidate;
  void relevance;
  return { ...withoutRelevance, score, scoreReasons: [] };
}
