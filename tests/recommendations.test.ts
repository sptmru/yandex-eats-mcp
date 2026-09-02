import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { YandexEatsClient } from "../src/eats/client.js";
import { diversifyResults } from "../src/recommendations/diversify.js";
import {
  evaluateIntent,
  expandSearchIntents,
  parseRecommendationIntentGroups,
} from "../src/recommendations/intents.js";
import { normalizeDish } from "../src/recommendations/normalize.js";
import { FoodPreferenceStore } from "../src/recommendations/preferences-store.js";
import { scoreCandidate, scoreSearchCandidate } from "../src/recommendations/scoring.js";
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
    expect(expandSearchIntents({
      query: "обед",
      categories: ["fish", "рыба", "salad", "салат"],
    })).toEqual(["рыба", "салат"]);
  });

  it("does not classify tortellini as cake from a partial Russian word match", () => {
    expect(normalizeDish({ name: "Тортеллини с куриным бульоном" }).categories).toEqual(["soup"]);
  });

  it.each([
    "Салат с бурратой и помидорами",
    "Зеленый салат с авокадо и сушеными помидорами",
  ])("does not match the mussel stem inside помидорами: %s", (name) => {
    const normalized = normalizeDish({ name });

    expect(normalized.categories).toContain("salad");
    expect(normalized.categories).not.toContain("seafood");
    expect(normalized.proteins).not.toContain("mussels");
  });

  it.each(["Fish & chips", "Фиш энд чипс", "Фиш и чипсы"])(
    "recognizes compound fried dishes and increases heaviness: %s",
    (name) => {
      const normalized = normalizeDish({ name });

      expect(normalized.categories).toContain("fish");
      expect(normalized.fried).toBe(true);
      expect(normalized.heaviness).toBeGreaterThan(0.65);
    },
  );

  it("does not award secondary fish or light modifiers when the required salad concept is absent", () => {
    const trout = normalizeDish({ name: "Шашлык из форели" });
    const match = evaluateIntent("легкий салат с рыбой", trout, "Шашлык из форели");

    expect(match).toMatchObject({
      requiredTerms: ["salad"],
      modifierTerms: ["fish", "light"],
      matchedTerms: [],
      intentCoverage: 0,
      matchedIntent: false,
    });
  });

  it("requires the head concept before modifiers can contribute intent coverage", () => {
    const lightTrout = normalizeDish({ name: "Легкая форель на пару" });
    const lightSoup = normalizeDish({ name: "Овощной суп" });
    const heavySoup = normalizeDish({ name: "Сливочный сырный суп" });

    expect(evaluateIntent("легкий суп", lightTrout, "Легкая форель на пару")).toEqual({
      intent: "легкий суп",
      requiredTerms: ["soup"],
      modifierTerms: ["light"],
      matchedTerms: [],
      intentCoverage: 0,
      matchedIntent: false,
    });
    expect(evaluateIntent("легкий суп", lightSoup, "Овощной суп")).toMatchObject({
      matchedTerms: ["soup", "light"],
      intentCoverage: 1,
      matchedIntent: true,
    });
    expect(evaluateIntent("легкий суп", heavySoup, "Сливочный сырный суп")).toMatchObject({
      matchedTerms: ["soup"],
      intentCoverage: 0.5,
      matchedIntent: false,
    });
  });

  it.each([
    ["жареное мясо", "Креветки во фритюре", "meat", "fried"],
    ["острый суп", "Острая курица", "soup", "spicy"],
  ])("does not match %s from its modifier alone", (intent, name, required, modifier) => {
    const dish = normalizeDish({ name });

    expect(evaluateIntent(intent, dish, name)).toMatchObject({
      requiredTerms: [required],
      modifierTerms: [modifier],
      matchedTerms: [],
      intentCoverage: 0,
      matchedIntent: false,
    });
  });

  it.each([
    "Креветки в кляре",
    "Breaded shrimp",
    "Crispy battered shrimp",
    "Ծովախեցգետին տեմպուրա",
  ])("treats batter, breading, tempura, and Armenian fried markers as heavy fried preparation: %s", (name) => {
    const normalized = normalizeDish({ name });

    expect(normalized.fried).toBe(true);
    expect(normalized.heaviness).toBeGreaterThanOrEqual(0.7);
  });

  it("does not treat pasta or a 500 gram noodle bowl as light", () => {
    const tagliatelle = normalizeDish({ name: "Тальятелле с форелью" });
    const noodleBowl = normalizeDish({ name: "Боул с лапшой и овощами", weight: "500 г" });

    expect(tagliatelle.categories).toContain("pasta");
    expect(tagliatelle.heaviness).toBeGreaterThan(0.45);
    expect(evaluateIntent("легкая форель", tagliatelle, "Тальятелле с форелью").matchedTerms).toEqual(["trout"]);
    expect(noodleBowl.heaviness).toBeGreaterThan(0.45);
    expect(evaluateIntent("легкий боул", noodleBowl, "Боул с лапшой и овощами")).toMatchObject({
      matchedTerms: ["bowl"],
      intentCoverage: 0.5,
      matchedIntent: false,
    });
  });

  it("infers vegetarian only from positive ingredient or dietary evidence", () => {
    expect(normalizeDish({ name: "Цезарь" }).vegetarian).toBe(false);
    expect(normalizeDish({ name: "Поке с овощами" }).vegetarian).toBe(true);
    expect(normalizeDish({ name: "Поке с овощами и курицей" }).vegetarian).toBe(false);
    expect(normalizeDish({ name: "Вегетарианский салат" }).vegetarian).toBe(true);
  });

  it("keeps specific proteins required instead of matching on a cooking modifier alone", () => {
    const salmon = normalizeDish({ name: "Лосось на гриле" });

    expect(evaluateIntent("форель на гриле", salmon, "Лосось на гриле")).toMatchObject({
      requiredTerms: ["trout"],
      modifierTerms: ["grilled"],
      matchedTerms: [],
      intentCoverage: 0,
      matchedIntent: false,
    });
  });

  it("parses person-specific alternatives and a same-restaurant constraint", () => {
    expect(parseRecommendationIntentGroups(
      "На двоих из одного ресторана: Маше жареное мясо, мне легкое рыбное блюдо или салат.",
    )).toEqual({
      sameRestaurant: true,
      groups: [
        { id: "group-1", label: "Маше", alternatives: [["meat", "fried"]] },
        { id: "group-2", label: "мне", alternatives: [["fish", "light"], ["salad", "light"]] },
      ],
    });
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
    expect(scoreCandidate(candidate, { query: "fish", avoid: ["trout"] }, [])).toBeDefined();
  });

  it("does not double-weight translated aliases in scoring", () => {
    const candidate = makeCandidate({
      name: "Grilled salmon",
      normalized: normalizeDish({ name: "Grilled salmon" }),
    });
    const canonical = scoreCandidate(candidate, { query: "fish", prefer: ["fish"] }, []);
    const translated = scoreCandidate(candidate, { query: "fish", prefer: ["fish", "рыба"] }, []);

    expect(translated?.score).toBe(canonical?.score);
    expect(translated?.scoreReasons).toEqual(canonical?.scoreReasons);
  });

  it("ranks an exact dish-name match above a broader dish containing the same protein", () => {
    const exactNormalized = normalizeDish({ name: "Форель" });
    const broadNormalized = normalizeDish({ name: "Салат с форелью" });
    const exactMatch = evaluateIntent("форель", exactNormalized, "Форель");
    const broadMatch = evaluateIntent("форель", broadNormalized, "Салат с форелью");
    const exact = scoreSearchCandidate(makeCandidate({
      name: "Форель",
      normalized: exactNormalized,
      relevance: 1,
      matchedTerms: exactMatch.matchedTerms,
      intentCoverage: exactMatch.intentCoverage,
      matchedIntent: exactMatch.matchedIntent,
      intentMatches: [exactMatch],
      matchedIntents: ["форель"],
    }), ["форель"]);
    const broad = scoreSearchCandidate(makeCandidate({
      name: "Салат с форелью",
      normalized: broadNormalized,
      relevance: 1,
      matchedTerms: broadMatch.matchedTerms,
      intentCoverage: broadMatch.intentCoverage,
      matchedIntent: broadMatch.matchedIntent,
      intentMatches: [broadMatch],
      matchedIntents: ["форель"],
    }), ["форель"]);

    expect(exact.score).toBeGreaterThan(broad.score);
    expect(exact.scoreReasons).toContain("exact name match");
  });

  it("rejects fish and chips from a light-dish heaviness constraint", () => {
    const candidate = makeCandidate({
      name: "Фиш и чипсы",
      normalized: normalizeDish({ name: "Фиш и чипсы" }),
    });

    expect(scoreCandidate(candidate, { query: "легкое рыбное блюдо", maxHeaviness: 0.65 }, [])).toBeUndefined();
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
  it("does not return a light non-soup for the compound search intent light soup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "required-search-intent-"));
    temporaryDirectories.push(directory);
    const search = vi.fn().mockResolvedValue({
      query: "легкий суп",
      currency: "AMD",
      places: [{
        placeSlug: "mixed",
        name: "Mixed",
        business: "restaurant",
        available: true,
        eta: "20–30 min",
        rating: "4.8",
        promos: [],
        items: [
          { itemId: "trout", name: "Легкая форель на пару", price: 3000, currency: "AMD", adult: false, hasRequiredOptions: false },
          { itemId: "soup", name: "Овощной суп", price: 1800, currency: "AMD", adult: false, hasRequiredOptions: false },
        ],
      }],
    });
    const getMenu = vi.fn().mockResolvedValue({
      placeSlug: "mixed",
      currency: "AMD",
      categories: [{
        categoryId: "main",
        name: "Main",
        available: true,
        categories: [],
        items: [
          { itemId: "trout", name: "Легкая форель на пару", price: 3000, currency: "AMD", available: true, adult: false, optionGroups: [] },
          { itemId: "soup", name: "Овощной суп", price: 1800, currency: "AMD", available: true, adult: false, optionGroups: [] },
        ],
      }],
    });
    const service = new RecommendationService(
      { search, getMenu } as unknown as YandexEatsClient,
      new FoodPreferenceStore(directory, createLogger("silent")),
      createLogger("silent"),
      { maxIntents: 6, maxMenus: 10, maxPagesPerQuery: 1, menuConcurrency: 2, menuCacheTtlMs: 60_000 },
    );

    const result = await service.searchItems({ queries: ["легкий суп"], maxItems: 10 });

    expect(result.results.map((entry) => entry.itemId)).toEqual(["soup"]);
    expect(result.results[0]?.intentMatches[0]).toMatchObject({
      requiredTerms: ["soup"],
      modifierTerms: ["light"],
      matchedTerms: ["soup", "light"],
      intentCoverage: 1,
      matchedIntent: true,
    });
  });

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
      matchedTerms: ["fish"],
      intentCoverage: 1,
      matchedIntent: true,
      matchedIntents: ["fish"],
      intentMatches: [
        { intent: "fish", matchedTerms: ["fish"], intentCoverage: 1, matchedIntent: true },
        { intent: "seafood", matchedTerms: [], intentCoverage: 0, matchedIntent: false },
      ],
    });
  });

  it("selects distinct intent-group dishes from the restaurant with complete coverage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recommendation-groups-"));
    temporaryDirectories.push(directory);
    const search = vi.fn(({ query }: { query: string }) => Promise.resolve({
      query,
      currency: "AMD",
      places: [
        {
          placeSlug: "dors",
          name: "Dors",
          business: "restaurant",
          available: true,
          rating: "4.7",
          promos: [],
          items: query.includes("мяс") || query.includes("жар")
            ? [{ itemId: "meat", name: "Жареная говядина", price: 4200, currency: "AMD", adult: false, hasRequiredOptions: false }]
            : [{ itemId: "salad", name: "Легкий салат с форелью", price: 3200, currency: "AMD", adult: false, hasRequiredOptions: false }],
        },
        {
          placeSlug: "arigato",
          name: "Arigato",
          business: "restaurant",
          available: true,
          rating: "4.9",
          promos: [],
          items: [{ itemId: "fish", name: "Лосось", price: 3900, currency: "AMD", adult: false, hasRequiredOptions: false }],
        },
      ],
    }));
    const getMenu = vi.fn(({ placeSlug }: { placeSlug: string }) => Promise.resolve({
      placeSlug,
      currency: "AMD",
      categories: [{
        categoryId: "main",
        name: "Main",
        available: true,
        categories: [],
        items: placeSlug === "dors"
          ? [
              { itemId: "meat", name: "Жареная говядина", price: 4200, currency: "AMD", available: true, adult: false, optionGroups: [] },
              { itemId: "salad", name: "Легкий салат с форелью", price: 3200, currency: "AMD", available: true, adult: false, optionGroups: [] },
            ]
          : [
              { itemId: "fish", name: "Лосось на гриле", price: 3900, currency: "AMD", available: true, adult: false, optionGroups: [] },
              { itemId: "fish-2", name: "Тунец с овощами", price: 4100, currency: "AMD", available: true, adult: false, optionGroups: [] },
            ],
      }],
    }));
    const service = new RecommendationService(
      { search, getMenu } as unknown as YandexEatsClient,
      new FoodPreferenceStore(directory, createLogger("silent")),
      createLogger("silent"),
      { maxIntents: 6, maxMenus: 10, maxPagesPerQuery: 1, menuConcurrency: 2, menuCacheTtlMs: 60_000 },
    );

    const result = await service.recommend({
      query: "На двоих из одного ресторана: Маше жареное мясо, мне легкое рыбное блюдо или салат.",
      limit: 10,
    });

    expect(result.sameRestaurant).toBe(true);
    expect(result.restaurantCoverage).toMatchObject({ placeSlug: "dors", matchedGroups: 2, totalGroups: 2, coverage: 1 });
    expect(result.results.map((entry) => entry.itemId)).toEqual(["meat", "salad"]);
    expect(result.results.map((entry) => entry.matchedIntents)).toEqual([["Маше"], ["мне"]]);
    expect(new Set(result.results.map((entry) => entry.placeSlug))).toEqual(new Set(["dors"]));
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
    matchedTerms: ["dish"],
    intentCoverage: 1,
    matchedIntent: true,
    intentMatches: [{
      intent: "dish",
      requiredTerms: ["dish"],
      modifierTerms: [],
      matchedTerms: ["dish"],
      intentCoverage: 1,
      matchedIntent: true,
    }],
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
