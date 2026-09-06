import { afterEach, describe, expect, it, vi } from "vitest";
import type { YandexEatsClient } from "../src/eats/client.js";
import type { NormalizedMenu, NormalizedSearch } from "../src/eats/schemas.js";
import { createLogger } from "../src/logger.js";
import { EatsError, type EatsErrorCode } from "../src/mcp/errors.js";
import { expandSearchIntents, parseRecommendationIntentGroups } from "../src/recommendations/intents.js";
import type { FoodPreferenceStore } from "../src/recommendations/preferences-store.js";
import { RecommendationService, type RecommendationOptions } from "../src/recommendations/service.js";

afterEach(() => vi.useRealTimers());

describe("recommendation constraints", () => {
  it("returns multiple dishes from one restaurant for a single sameRestaurant intent", async () => {
    const service = makeService({
      search: vi.fn<ClientMethods["search"]>().mockResolvedValue(searchResponse(["first", "second"])),
      getMenu: vi.fn<ClientMethods["getMenu"]>(({ placeSlug }) => Promise.resolve(menu(placeSlug, ["Овощной салат", "Зеленый салат", "Салат с авокадо"]))),
    });

    const result = await service.recommend({ query: "салат", sameRestaurant: true, limit: 3 });

    expect(result.results).toHaveLength(3);
    expect(new Set(result.results.map((item) => item.placeSlug)).size).toBe(1);
    expect(result.restaurantCoverage).toMatchObject({ totalGroups: 1, matchedGroups: 1, coverage: 1 });
  });

  it("keeps fish available for one person while excluding it from the other person's salad", async () => {
    const query = "Из одного ресторана: мне салат без рыбы, ей рыба";
    const service = makeService({
      getMenu: vi.fn<ClientMethods["getMenu"]>(({ placeSlug }) => Promise.resolve(menu(placeSlug, ["Салат с лососем", "Овощной салат", "Форель на гриле"]))),
    });

    expect(expandSearchIntents({ query })).toEqual(expect.arrayContaining(["салат", "рыба"]));
    expect(parseRecommendationIntentGroups(query)).toMatchObject({
      excludedTerms: [],
      groups: [{ label: "мне", excludedTerms: ["fish"] }, { label: "ей", excludedTerms: [] }],
    });
    const result = await service.recommend({ query, limit: 5 });

    expect(result.results[0]?.name).toBe("Овощной салат");
    expect(result.results[1]?.normalized.categories).toContain("fish");
    expect(result.restaurantCoverage).toMatchObject({ matchedGroups: 2, coverage: 1 });
  });

  it.each([
    "Без жареного, из одного ресторана: мне салат без рыбы, ей рыба",
    "Из одного ресторана: мне салат без рыбы, ей рыба. Без жареного.",
    "Из одного ресторана: мне салат без рыбы, ей рыба; для всех без жареного",
  ])("combines shared and person-local exclusions: %s", (query) => {
    expect(parseRecommendationIntentGroups(query)).toMatchObject({
      excludedTerms: ["fried"],
      groups: [
        { label: "мне", excludedTerms: ["fried", "fish"] },
        { label: "ей", excludedTerms: ["fried"] },
      ],
    });
  });

  it("preserves anyOf alternatives with a generic query and enforces shared avoid filters", async () => {
    const service = makeService({
      getMenu: vi.fn<ClientMethods["getMenu"]>(({ placeSlug }) => Promise.resolve(menu(placeSlug, ["Овощной салат", "Форель на гриле", "Жареная говядина"]))),
    });
    const input = {
      query: "обед",
      anyOf: [{ categories: ["salad"] }, { proteins: ["fish"], cookingMethods: ["grilled"] }],
      maxPerRestaurant: 5,
    };

    const result = await service.recommend(input);
    expect(result.results.map((item) => item.name)).toEqual(expect.arrayContaining(["Овощной салат", "Форель на гриле"]));
    expect(result.results).toHaveLength(2);
    const avoidFish = await service.recommend({ ...input, avoid: ["fish"] });
    expect(avoidFish.results.map((item) => item.name)).toEqual(["Овощной салат"]);
  });
});

describe("recommendation runtime budgets", () => {
  it("limits simultaneous searches and keeps cursor pages sequential within each query", async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const search = vi.fn<ClientMethods["search"]>(async ({ query, cursor }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { ...searchResponse(["place"], query), ...(!cursor ? { cursor: `${query}-next` } : {}) };
    });
    const service = makeService({ search }, { searchConcurrency: 2, maxPagesPerQuery: 2 });
    const pending = service.searchItems({ queries: ["salad", "fish", "soup", "meat"] });

    await vi.advanceTimersByTimeAsync(0);
    expect(search).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.warnings).toEqual([]);
    expect(peak).toBe(2);
    expect(search.mock.calls.map(([input]) => `${input.query}:${input.cursor ?? "first"}`)).toEqual([
      "salad:first", "fish:first", "salad:salad-next", "fish:fish-next",
      "soup:first", "meat:first", "soup:soup-next", "meat:meat-next",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reserves time to verify menus after a hanging search and reports partial results", async () => {
    vi.useFakeTimers();
    let hangingSignal: AbortSignal | undefined;
    const search = vi.fn<ClientMethods["search"]>((input, options) => {
      if (input.query === "fish") {
        hangingSignal = options?.signal;
        return new Promise<NormalizedSearch>(() => undefined);
      }
      return Promise.resolve(searchResponse(["place"], input.query));
    });
    const service = makeService({ search }, { deadlineMs: 100 });
    const pending = service.searchItems({ queries: ["salad", "fish"] });

    await vi.advanceTimersByTimeAsync(61);
    const result = await pending;
    expect(hangingSignal?.aborted).toBe(true);
    expect(result.menusLoaded).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("Search time budget reached");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns verified dishes by the deadline and cancels hanging menus without launching queued menus", async () => {
    vi.useFakeTimers();
    let hangingSignal: AbortSignal | undefined;
    const getMenu = vi.fn<ClientMethods["getMenu"]>((input, options) => {
      if (input.placeSlug === "second") {
        hangingSignal = options?.signal;
        return new Promise<NormalizedMenu>(() => undefined);
      }
      return Promise.resolve(menu(input.placeSlug));
    });
    const service = makeService({
      search: vi.fn<ClientMethods["search"]>().mockResolvedValue(searchResponse(["first", "second", "third"])),
      getMenu,
    }, { deadlineMs: 100, menuConcurrency: 1 });
    const pending = service.searchItems({ queries: ["salad"] });

    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.results.map((item) => item.placeSlug)).toEqual(["first"]);
    expect(result.warnings.join(" ")).toContain("Recommendation deadline reached");
    expect(hangingSignal?.aborted).toBe(true);
    expect(getMenu.mock.calls.map(([input]) => input.placeSlug)).toEqual(["first", "second"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains successful search results when another query has a recoverable upstream error", async () => {
    const service = makeService({
      search: vi.fn<ClientMethods["search"]>(({ query }) => {
        if (query === "fish") return Promise.reject(new EatsError("UPSTREAM_RATE_LIMITED", "Rate limited"));
        return Promise.resolve(searchResponse(["place"], query));
      }),
    });
    const result = await service.searchItems({ queries: ["salad", "fish"] });
    expect(result.results).toHaveLength(1);
    expect(result.warnings).toEqual(["Could not complete search for fish; results may be incomplete."]);
  });

  it.each(["AUTH_EXPIRED", "AUTH_NOT_CONFIGURED", "DELIVERY_LOCATION_NOT_CONFIGURED"] satisfies EatsErrorCode[])(
    "propagates %s from searches and menus instead of returning apparent success", async (code) => {
      const error = new EatsError(code, "Refresh configuration");
      const searchFailure = makeService({ search: vi.fn<ClientMethods["search"]>().mockRejectedValue(error) });
      await expect(searchFailure.searchItems({ queries: ["salad"] })).rejects.toBe(error);
      const menuFailure = makeService({ getMenu: vi.fn<ClientMethods["getMenu"]>().mockRejectedValue(error) });
      await expect(menuFailure.searchItems({ queries: ["salad"] })).rejects.toBe(error);
    },
  );

  it("does not convert programming failures into partial success", async () => {
    const error = new TypeError("Unexpected state");
    const service = makeService({ search: vi.fn<ClientMethods["search"]>().mockRejectedValue(error) });
    await expect(service.searchItems({ queries: ["salad"] })).rejects.toBe(error);
  });

  it("propagates caller cancellation to searches and clears request timers", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let received: AbortSignal | undefined;
    const search = vi.fn<ClientMethods["search"]>((_input, options) => {
      received = options?.signal;
      return new Promise<NormalizedSearch>(() => undefined);
    });
    const service = makeService({ search });
    const pending = service.searchItems({ queries: ["salad", "fish"] }, caller.signal);
    const reason = new Error("Caller cancelled");
    const assertion = expect(pending).rejects.toBe(reason);
    caller.abort(reason);
    await assertion;
    expect(received?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels sibling searches immediately when authentication fails", async () => {
    vi.useFakeTimers();
    const failure = deferred<NormalizedSearch>();
    let siblingSignal: AbortSignal | undefined;
    const error = new EatsError("AUTH_EXPIRED", "Session expired");
    const search = vi.fn<ClientMethods["search"]>(async ({ query }, options) => {
      if (query === "salad") {
        await failure.promise;
        throw error;
      }
      siblingSignal = options?.signal;
      return await new Promise<NormalizedSearch>(() => undefined);
    });
    const service = makeService({ search });
    const pending = service.searchItems({ queries: ["salad", "fish"] });
    const assertion = expect(pending).rejects.toBe(error);
    failure.resolve(searchResponse([]));
    await assertion;
    expect(siblingSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes preference loading in the overall recommendation deadline", async () => {
    vi.useFakeTimers();
    const search = vi.fn<ClientMethods["search"]>();
    const service = new RecommendationService(
      { search } as unknown as YandexEatsClient,
      { list: () => new Promise(() => undefined) } as unknown as FoodPreferenceStore,
      createLogger("silent"),
      { maxIntents: 6, maxMenus: 10, maxPagesPerQuery: 1, menuConcurrency: 2, menuCacheTtlMs: 60_000, deadlineMs: 100 },
    );
    const pending = service.recommend({ query: "salad" });
    const assertion = expect(pending).rejects.toThrow("Recommendation time budget reached");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(search).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shared recommendation menu cache", () => {
  it("shares an in-flight menu and keeps it alive when only one subscriber cancels", async () => {
    vi.useFakeTimers();
    const gate = deferred<NormalizedMenu>();
    let received: AbortSignal | undefined;
    const getMenu = vi.fn<ClientMethods["getMenu"]>((_input, options) => {
      received = options?.signal;
      return gate.promise;
    });
    const service = makeService({ getMenu });
    const firstCaller = new AbortController();
    const first = service.searchItems({ queries: ["salad"] }, firstCaller.signal);
    const second = service.searchItems({ queries: ["salad"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(getMenu).toHaveBeenCalledTimes(1);
    const rejection = expect(first).rejects.toThrow("Cancelled first");
    firstCaller.abort(new Error("Cancelled first"));
    await rejection;
    expect(received?.aborted).toBe(false);
    gate.resolve(menu("place"));
    expect((await second).results).toHaveLength(1);
    await service.searchItems({ queries: ["salad"] });
    expect(getMenu).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a menu when all subscribers leave and allows a fresh request without caching the abandoned result", async () => {
    vi.useFakeTimers();
    const abandoned = deferred<NormalizedMenu>();
    let received: AbortSignal | undefined;
    const getMenu = vi.fn<ClientMethods["getMenu"]>((_input, options) => {
      received = options?.signal;
      return abandoned.promise;
    });
    const service = makeService({ getMenu });
    const caller = new AbortController();
    const pending = service.searchItems({ queries: ["salad"] }, caller.signal);
    await vi.advanceTimersByTimeAsync(0);
    const rejection = expect(pending).rejects.toThrow("Cancelled");
    caller.abort(new Error("Cancelled"));
    await rejection;
    expect(received?.aborted).toBe(true);
    getMenu.mockImplementation((input) => Promise.resolve(menu(input.placeSlug, ["Fresh salad"])));
    const fresh = await service.searchItems({ queries: ["salad"] });
    expect(getMenu).toHaveBeenCalledTimes(2);
    expect(fresh.results[0]?.name).toBe("Fresh salad");
    abandoned.resolve(menu("place", ["Stale salad"]));
    await vi.advanceTimersByTimeAsync(0);
    const cached = await service.searchItems({ queries: ["salad"] });
    expect(cached.results[0]?.name).toBe("Fresh salad");
    expect(getMenu).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evicts the least recently used menu and reloads expired cache entries", async () => {
    vi.useFakeTimers();
    let slug = "first";
    const getMenu = vi.fn<ClientMethods["getMenu"]>((input) => Promise.resolve(menu(input.placeSlug)));
    const service = makeService({
      search: vi.fn<ClientMethods["search"]>(() => Promise.resolve(searchResponse([slug]))),
      getMenu,
    }, { menuCacheMaxEntries: 2, menuCacheTtlMs: 100 });
    for (const next of ["first", "second", "first", "third", "second"]) {
      slug = next;
      await service.searchItems({ queries: ["salad"] });
    }
    expect(getMenu.mock.calls.map(([input]) => input.placeSlug)).toEqual(["first", "second", "third", "second"]);
    await vi.advanceTimersByTimeAsync(101);
    await service.searchItems({ queries: ["salad"] });
    expect(getMenu).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });
});

type ClientMethods = Pick<YandexEatsClient, "search" | "getMenu">;

function makeService(overrides: Partial<ClientMethods> = {}, options: Partial<RecommendationOptions> = {}): RecommendationService {
  const client: ClientMethods = {
    search: ({ query }) => Promise.resolve(searchResponse(["place"], query)),
    getMenu: ({ placeSlug }) => Promise.resolve(menu(placeSlug)),
    ...overrides,
  };
  return new RecommendationService(
    client as YandexEatsClient,
    { list: () => Promise.resolve([]) } as unknown as FoodPreferenceStore,
    createLogger("silent"),
    { maxIntents: 6, maxMenus: 10, maxPagesPerQuery: 1, menuConcurrency: 2, menuCacheTtlMs: 60_000, ...options },
  );
}

function searchResponse(slugs: string[], query = "salad"): NormalizedSearch {
  return {
    query,
    currency: "AMD",
    places: slugs.map((placeSlug) => ({
      placeSlug, name: placeSlug, business: "restaurant", available: true, promos: [],
      items: [{ itemId: "item-0", name: "Овощной салат", price: 1000, currency: "AMD", adult: false, hasRequiredOptions: false }],
    })),
  };
}

function menu(placeSlug: string, names = ["Овощной салат"]): NormalizedMenu {
  return {
    placeSlug,
    currency: "AMD",
    categories: [{
      categoryId: "main", name: "Main", available: true, categories: [],
      items: names.map((name, index) => ({
        itemId: `item-${index}`, name, price: 1000, currency: "AMD", available: true, adult: false, optionGroups: [],
      })),
    }],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
