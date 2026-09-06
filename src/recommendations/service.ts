import type { Logger } from "pino";
import type { YandexEatsClient } from "../eats/client.js";
import { EatsError } from "../mcp/errors.js";
import type { NormalizedMenu, NormalizedMenuCategory, NormalizedSearch } from "../eats/schemas.js";
import { diversifyResults } from "./diversify.js";
import {
  evaluateIntent,
  evaluateIntentGroup,
  expandSearchIntents,
  parseRecommendationIntentGroups,
} from "./intents.js";
import { normalizeDish, normalizeText } from "./normalize.js";
import { calculateRelevance, scoreCandidate, scoreSearchCandidate } from "./scoring.js";
import type {
  DishCandidate,
  FoodResult,
  FoodSearchResult,
  IntentMatch,
  RecommendFoodInput,
  RecommendationIntentGroup,
  RecommendationResult,
  SearchItemsInput,
} from "./types.js";
import type { FoodPreferenceStore, FoodFeedbackInput } from "./preferences-store.js";

type PlaceEvidence = NormalizedSearch["places"][number] & {
  matchedQueries: Set<string>;
  searchItems: Map<string, { names: Set<string>; queries: Set<string> }>;
};

type MenuItemWithCategories = NormalizedMenuCategory["items"][number] & {
  menuCategories: string[];
};

export type RecommendationOptions = {
  maxIntents: number;
  maxMenus: number;
  maxPagesPerQuery: number;
  menuConcurrency: number;
  menuCacheTtlMs: number;
  deadlineMs?: number;
  searchConcurrency?: number;
  menuCacheMaxEntries?: number;
};

const DEFAULT_OPTIONS: Required<RecommendationOptions> = {
  maxIntents: 6,
  maxMenus: 12,
  maxPagesPerQuery: 2,
  menuConcurrency: 3,
  menuCacheTtlMs: 5 * 60_000,
  deadlineMs: 45_000,
  searchConcurrency: 3,
  menuCacheMaxEntries: 100,
};

type MenuRequest = {
  controller: AbortController;
  promise: Promise<NormalizedMenu>;
  subscribers: number;
  settled: boolean;
};

export class RecommendationService {
  private readonly menuCache = new Map<string, { loadedAt: number; menu: NormalizedMenu }>();
  private readonly menuRequests = new Map<string, MenuRequest>();
  private readonly options: Required<RecommendationOptions>;

  constructor(
    private readonly client: YandexEatsClient,
    private readonly preferences: FoodPreferenceStore,
    private readonly logger: Logger,
    options: RecommendationOptions = DEFAULT_OPTIONS,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    }
  }

  async initialize(): Promise<void> {
    await this.preferences.initialize();
  }

  async searchItems(input: SearchItemsInput, signal?: AbortSignal): Promise<FoodSearchResult> {
    return await withDeadline(signal, this.options.deadlineMs, async (deadlineSignal) => {
      const queries = uniqueQueries(input.queries).slice(0, this.options.maxIntents);
      const gathered = await this.gatherCandidates({
        queries,
        maxPlaces: Math.min(input.maxPlaces ?? this.options.maxMenus, this.options.maxMenus),
        maxPagesPerQuery: Math.min(input.maxPagesPerQuery ?? this.options.maxPagesPerQuery, this.options.maxPagesPerQuery),
      }, deadlineSignal, signal);
      const maxItems = input.maxItems ?? 50;
      const scored = gathered.candidates
        .map((candidate) => scoreSearchCandidate(candidate, queries))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      const candidates = input.deduplicate === false ? scored : deduplicateResults(scored);
      const results = rankSearchResults(candidates, maxItems);

      return {
        queries,
        candidatePlaces: gathered.candidatePlaces,
        shortlistedPlaces: gathered.shortlistedPlaces,
        shortlistReasons: gathered.shortlistReasons,
        menusLoaded: gathered.menusLoaded,
        results,
        warnings: gathered.warnings,
      };
    });
  }

  async recommend(input: RecommendFoodInput, signal?: AbortSignal): Promise<RecommendationResult> {
    return await withDeadline(signal, this.options.deadlineMs, async (deadlineSignal) => {
      const preferences = await waitForSignal(this.preferences.list(), deadlineSignal);
      const parsedIntent = parseRecommendationIntentGroups(input.query);
      const sameRestaurant = input.sameRestaurant ?? parsedIntent.sameRestaurant;
      const searchIntents = expandSearchIntents({
        query: input.query,
        ...(input.categories ? { categories: input.categories } : {}),
        ...(input.cuisines ? { cuisines: input.cuisines } : {}),
        ...(input.proteins ? { proteins: input.proteins } : {}),
        ...(input.cookingMethods ? { cookingMethods: input.cookingMethods } : {}),
        ...(input.anyOf ? { anyOf: input.anyOf } : {}),
        ...(input.prefer ? { prefer: input.prefer } : {}),
        maxIntents: this.options.maxIntents,
      });
      const gathered = await this.gatherCandidates({
        queries: searchIntents,
        maxPlaces: this.options.maxMenus,
        maxPagesPerQuery: this.options.maxPagesPerQuery,
      }, deadlineSignal, signal);
      const scored = gathered.candidates
        .map((candidate) => applyIntentGroups(candidate, parsedIntent.groups))
        .map((candidate) => scoreCandidate(candidate, input, preferences))
        .filter((candidate): candidate is FoodResult => candidate !== undefined)
        .sort((a, b) => b.score - a.score);
      const limit = input.limit ?? 10;
      const deduplicated = deduplicateResults(scored);
      const grouped = sameRestaurant
        ? selectSameRestaurantResults(deduplicated, parsedIntent.groups, limit)
        : undefined;
      const results = sameRestaurant ? grouped?.results ?? [] : diversifyResults(deduplicated, {
          limit,
          maxPerRestaurant: input.maxPerRestaurant ?? 2,
          maxPerCategory: input.maxPerCategory ?? 2,
          exploration: input.exploration ?? 0.35,
        });

      return {
        query: input.query,
        searchIntents,
        intentGroups: parsedIntent.groups,
        excludedTerms: parsedIntent.excludedTerms,
        sameRestaurant,
        ...(grouped?.restaurantCoverage ? { restaurantCoverage: grouped.restaurantCoverage } : {}),
        candidatePlaces: gathered.candidatePlaces,
        shortlistedPlaces: gathered.shortlistedPlaces,
        shortlistReasons: gathered.shortlistReasons,
        menusLoaded: gathered.menusLoaded,
        results,
        warnings: gathered.warnings,
      };
    });
  }

  async recordFeedback(input: FoodFeedbackInput) {
    return await this.preferences.record(input);
  }

  async getPreferences() {
    return { preferences: await this.preferences.list() };
  }

  private async gatherCandidates(input: {
    queries: string[];
    maxPlaces: number;
    maxPagesPerQuery: number;
  }, deadlineSignal: AbortSignal, signal?: AbortSignal): Promise<{
    candidates: DishCandidate[];
    candidatePlaces: number;
    shortlistedPlaces: number;
    shortlistReasons: Record<string, number>;
    menusLoaded: number;
    warnings: string[];
  }> {
    const places = new Map<string, PlaceEvidence>();
    const warnings: string[] = [];
    const searches = new Map<string, NormalizedSearch[]>();
    // Keep a menu verification budget even when an individual search hangs.
    await withDeadline(deadlineSignal, Math.max(1, Math.floor(this.options.deadlineMs * 0.6)), async (searchSignal) => {
      await mapLimit(input.queries, this.options.searchConcurrency, async (query) => {
        if (searchSignal.aborted) return;
        const pages: NormalizedSearch[] = [];
        searches.set(query, pages);
        let cursor: string | undefined;
        try {
          for (let page = 0; page < input.maxPagesPerQuery; page += 1) {
            searchSignal.throwIfAborted();
            const search = await waitForSignal(this.client.search({
              query,
              maxPlaces: 50,
              maxItemsPerPlace: 25,
              ...(cursor ? { cursor } : {}),
            }, { signal: searchSignal }), searchSignal);
            pages.push(search);
            cursor = search.cursor;
            if (!cursor) break;
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (!isPartialResultError(error)) throw error;
          this.logger.warn({ err: error, query }, "Recommendation search failed");
          warnings.push(`Could not complete search for ${query}; results may be incomplete.`);
        }
      });
      if (searchSignal.aborted) warnings.push("Search time budget reached; results may be incomplete.");
    });
    // Merge in query order so network completion order cannot change tie breaks.
    for (const query of input.queries) {
      for (const search of searches.get(query) ?? []) mergeSearchEvidence(places, search, query);
    }

    const shortlist = selectDiversePlaces(
      [...places.values()],
      input.queries,
      Math.min(places.size, input.maxPlaces),
    );
    const rankedPlaces = shortlist.places;
    let menusLoaded = 0;
    const menuResults = await mapLimit(rankedPlaces, this.options.menuConcurrency, async (place) => {
      try {
        if (deadlineSignal.aborted) return undefined;
        const menu = await this.loadMenu(place.placeSlug, deadlineSignal);
        menusLoaded += 1;
        return { place, menu };
      } catch (error) {
        signal?.throwIfAborted();
        if (!isPartialResultError(error)) throw error;
        this.logger.warn({ err: error, placeSlug: place.placeSlug }, "Recommendation menu load failed");
        warnings.push(`Could not load the current menu for ${place.name}.`);
        return undefined;
      }
    });
    if (deadlineSignal.aborted) warnings.push("Recommendation deadline reached; results may be incomplete.");

    const candidates: DishCandidate[] = [];
    for (const result of menuResults) {
      if (!result) continue;
      for (const item of flattenMenu(result.menu.categories)) {
        if (!item.available || item.inStock === 0) continue;
        const searchEvidence = findItemEvidence(result.place, item.itemId, item.publicId);
        const searchName = searchEvidence ? [...searchEvidence.names][0] : undefined;
        const normalized = normalizeDish({
          name: [item.name, searchName].filter(Boolean).join(" "),
          ...(item.description ? { description: item.description } : {}),
          menuCategories: item.menuCategories,
          ...(item.weight ? { weight: item.weight } : {}),
        });
        const text = [item.name, searchName, item.description, ...item.menuCategories].filter(Boolean).join(" ");
        const intentScores = input.queries.map((query) => {
          const match = evaluateIntent(query, normalized, text);
          const lexicalRelevance = calculateRelevance({
            name: [item.name, searchName].filter(Boolean).join(" "),
            ...(item.description ? { description: item.description } : {}),
            menuCategories: item.menuCategories,
            query,
            normalized,
          });
          const evidenceRelevance = searchEvidence?.queries.has(query)
            ? 0.1 + match.intentCoverage * 0.85
            : 0;
          return { ...match, relevance: Math.max(lexicalRelevance, evidenceRelevance) };
        });
        const matchedIntents = intentScores.filter((entry) => entry.matchedIntent).map((entry) => entry.intent);
        const intentCoverage = Math.max(...intentScores.map((entry) => entry.intentCoverage));
        const matchedTerms = unique(intentScores.flatMap((entry) => entry.matchedTerms));
        if (intentCoverage === 0) continue;
        const relevance = Math.max(...intentScores.map((entry) => entry.relevance));
        const rating = parseRating(result.place.rating);
        candidates.push({
          placeSlug: result.place.placeSlug,
          placeName: result.place.name,
          placeBusiness: result.place.business,
          ...(result.place.eta ? { eta: result.place.eta } : {}),
          ...(rating !== undefined ? { rating } : {}),
          ...(result.place.priceCategory ? { priceCategory: result.place.priceCategory } : {}),
          promos: result.place.promos,
          itemId: item.itemId,
          ...(item.publicId ? { publicId: item.publicId } : {}),
          name: item.name,
          ...(searchName && normalizeText(searchName) !== normalizeText(item.name) ? { searchName } : {}),
          ...(item.description ? { description: item.description } : {}),
          price: item.price,
          currency: item.currency,
          ...(item.weight ? { weight: item.weight } : {}),
          adult: item.adult,
          hasRequiredOptions: item.optionGroups.some((group) => group.required || group.minSelected > 0),
          menuCategories: item.menuCategories,
          normalized,
          matchedTerms,
          intentCoverage,
          matchedIntent: matchedIntents.length > 0,
          intentMatches: intentScores.map(({ relevance: _relevance, ...match }) => {
            void _relevance;
            return match;
          }),
          matchedIntents,
          relevance,
        });
      }
    }

    return {
      candidates: deduplicateCandidates(candidates),
      candidatePlaces: places.size,
      shortlistedPlaces: shortlist.places.length,
      shortlistReasons: shortlist.reasons,
      menusLoaded,
      warnings,
    };
  }

  private async loadMenu(placeSlug: string, signal: AbortSignal): Promise<NormalizedMenu> {
    signal.throwIfAborted();
    const now = Date.now();
    for (const [slug, cached] of this.menuCache) {
      if (now - cached.loadedAt >= this.options.menuCacheTtlMs) this.menuCache.delete(slug);
    }
    const cached = this.menuCache.get(placeSlug);
    if (cached) {
      this.menuCache.delete(placeSlug);
      this.menuCache.set(placeSlug, cached);
      return cached.menu;
    }
    let request = this.menuRequests.get(placeSlug);
    if (!request) {
      const controller = new AbortController();
      const created: MenuRequest = {
        controller,
        subscribers: 0,
        settled: false,
        promise: Promise.resolve().then(async () => {
          controller.signal.throwIfAborted();
          const menu = await this.client.getMenu({ placeSlug }, { signal: controller.signal });
          controller.signal.throwIfAborted();
          this.menuCache.set(placeSlug, { loadedAt: Date.now(), menu });
          while (this.menuCache.size > this.options.menuCacheMaxEntries) {
            const oldest = this.menuCache.keys().next().value;
            if (oldest !== undefined) this.menuCache.delete(oldest);
          }
          return menu;
        }).finally(() => {
          created.settled = true;
          if (this.menuRequests.get(placeSlug) === created) this.menuRequests.delete(placeSlug);
        }),
      };
      this.menuRequests.set(placeSlug, created);
      request = created;
    }
    request.subscribers += 1;
    try {
      return await waitForSignal(request.promise, signal);
    } finally {
      request.subscribers -= 1;
      if (request.subscribers === 0 && !request.settled) {
        if (this.menuRequests.get(placeSlug) === request) this.menuRequests.delete(placeSlug);
        request.controller.abort(new DOMException("No active menu subscribers", "AbortError"));
      }
    }
  }
}

class RecommendationDeadlineError extends Error {
  constructor() {
    super("Recommendation time budget reached");
  }
}

async function withDeadline<T>(
  parent: AbortSignal | undefined,
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new RecommendationDeadlineError()), milliseconds);
  try {
    return await operation(signal);
  } finally {
    clearTimeout(timer);
    controller.abort(new DOMException("Recommendation stage finished", "AbortError"));
  }
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error("Recommendation cancelled", { cause: reason }));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function isPartialResultError(error: unknown): boolean {
  return error instanceof RecommendationDeadlineError || (error instanceof EatsError && [
    "UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE", "UPSTREAM_RATE_LIMITED", "UPSTREAM_BAD_RESPONSE",
  ].includes(error.code));
}

function mergeSearchEvidence(places: Map<string, PlaceEvidence>, search: NormalizedSearch, query: string): void {
  for (const place of search.places) {
    if (!place.available) continue;
    const previous = places.get(place.placeSlug);
    if (previous) {
      previous.matchedQueries.add(query);
      for (const item of place.items) addSearchItemEvidence(previous.searchItems, item, query);
      if (place.promos.length > previous.promos.length) previous.promos = place.promos;
      if (!previous.rating && place.rating) previous.rating = place.rating;
      continue;
    }
    places.set(place.placeSlug, {
      ...place,
      matchedQueries: new Set([query]),
      searchItems: createSearchItemEvidence(place.items, query),
    });
  }
}

function placeEvidenceScore(place: PlaceEvidence): number {
  const itemEvidence = Math.min(5, place.searchItems.size) * 2;
  return itemEvidence + place.matchedQueries.size + ratingSignal(parseRating(place.rating));
}

function selectDiversePlaces(
  places: PlaceEvidence[],
  queries: string[],
  limit: number,
): { places: PlaceEvidence[]; reasons: Record<string, number> } {
  const ranked = [...places].sort((left, right) => placeEvidenceScore(right) - placeEvidenceScore(left));
  const selected: PlaceEvidence[] = [];
  const selectedSlugs = new Set<string>();
  const reasons: Record<string, number> = {};

  const select = (place: PlaceEvidence, reason: string): void => {
    selected.push(place);
    selectedSlugs.add(place.placeSlug);
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };

  while (selected.length < limit) {
    let added = false;
    for (const query of queries) {
      const candidate = ranked.find(
        (place) =>
          !selectedSlugs.has(place.placeSlug) &&
          [...place.searchItems.values()].some((item) => item.queries.has(query)),
      );
      if (!candidate) continue;
      select(candidate, query);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }

  for (const place of ranked) {
    if (selected.length >= limit) break;
    if (selectedSlugs.has(place.placeSlug)) continue;
    select(place, "exploration");
  }
  return { places: selected, reasons };
}

function createSearchItemEvidence(
  items: NormalizedSearch["places"][number]["items"],
  query: string,
): Map<string, { names: Set<string>; queries: Set<string> }> {
  const result = new Map<string, { names: Set<string>; queries: Set<string> }>();
  for (const item of items) addSearchItemEvidence(result, item, query);
  return result;
}

function addSearchItemEvidence(
  evidence: Map<string, { names: Set<string>; queries: Set<string> }>,
  item: NormalizedSearch["places"][number]["items"][number],
  query: string,
): void {
  for (const key of [item.itemId, item.publicId].filter((value): value is string => value !== undefined)) {
    const previous = evidence.get(key);
    if (previous) {
      previous.names.add(item.name);
      previous.queries.add(query);
    } else {
      evidence.set(key, { names: new Set([item.name]), queries: new Set([query]) });
    }
  }
}

function findItemEvidence(
  place: PlaceEvidence,
  itemId: string,
  publicId?: string,
): { names: Set<string>; queries: Set<string> } | undefined {
  return place.searchItems.get(itemId) ?? (publicId ? place.searchItems.get(publicId) : undefined);
}

function flattenMenu(categories: NormalizedMenuCategory[], parents: string[] = []): MenuItemWithCategories[] {
  return categories.flatMap((category) => {
    const path = [...parents, category.name];
    return [
      ...category.items.map((item) => ({ ...item, menuCategories: path })),
      ...flattenMenu(category.categories, path),
    ];
  });
}

async function mapLimit<T, R>(values: T[], limit: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  });
  await Promise.all(workers);
  return results;
}

function deduplicateCandidates(candidates: DishCandidate[]): DishCandidate[] {
  const results = new Map<string, DishCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.placeSlug}:${candidate.publicId ?? candidate.itemId}`;
    const previous = results.get(key);
    if (!previous || candidate.relevance > previous.relevance) results.set(key, candidate);
  }
  return [...results.values()];
}

function deduplicateResults(results: FoodResult[]): FoodResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = `${result.placeSlug}:${result.publicId ?? result.itemId}:${normalizeText(result.name)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankSearchResults(results: FoodResult[], limit: number): FoodResult[] {
  const remaining = [...results];
  const selected: FoodResult[] = [];
  const restaurantCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (!candidate) continue;
      const category = candidate.normalized.categories[0] ?? candidate.menuCategories[0] ?? "other";
      const restaurantPenalty = Math.min(0.06, (restaurantCounts.get(candidate.placeSlug) ?? 0) * 0.025);
      const categoryPenalty = Math.min(0.03, (categoryCounts.get(category) ?? 0) * 0.01);
      const utility = candidate.score - restaurantPenalty - categoryPenalty;
      if (utility > bestUtility) {
        bestUtility = utility;
        bestIndex = index;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (!chosen) break;
    selected.push(chosen);
    restaurantCounts.set(chosen.placeSlug, (restaurantCounts.get(chosen.placeSlug) ?? 0) + 1);
    const category = chosen.normalized.categories[0] ?? chosen.menuCategories[0] ?? "other";
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }

  return selected;
}

export function selectSameRestaurantResults(
  candidates: FoodResult[],
  groups: RecommendationIntentGroup[],
  limit: number,
): {
  results: FoodResult[];
  restaurantCoverage?: {
    placeSlug: string;
    placeName: string;
    matchedGroups: number;
    totalGroups: number;
    coverage: number;
  };
} | undefined {
  const byRestaurant = new Map<string, FoodResult[]>();
  for (const candidate of candidates) {
    const previous = byRestaurant.get(candidate.placeSlug) ?? [];
    previous.push(candidate);
    byRestaurant.set(candidate.placeSlug, previous);
  }

  const ranked = [...byRestaurant.entries()].map(([placeSlug, restaurantCandidates]) => {
    const options = groups.map((group, groupIndex) => ({
      groupIndex,
      candidates: restaurantCandidates
        .map((candidate) => ({
          candidate,
          match: evaluateIntentGroup(group, candidate.normalized, candidateText(candidate)),
        }))
        .filter((entry) => entry.match.intentCoverage > 0 && entry.match.matchedExcludedTerms.length === 0)
        .sort((left, right) =>
          Number(right.match.matchedIntent) - Number(left.match.matchedIntent) ||
          right.match.intentCoverage - left.match.intentCoverage ||
          right.candidate.score - left.candidate.score
        ),
    })).sort((left, right) => left.candidates.length - right.candidates.length);
    const used = new Set<string>();
    const selected: Array<{ groupIndex: number; candidate: FoodResult; match: IntentMatch }> = [];
    for (const option of options) {
      const match = option.candidates.find((entry) => !used.has(entry.candidate.itemId));
      if (!match) continue;
      used.add(match.candidate.itemId);
      selected.push({ groupIndex: option.groupIndex, candidate: match.candidate, match: match.match });
    }
    selected.sort((left, right) => left.groupIndex - right.groupIndex);
    return {
      placeSlug,
      placeName: restaurantCandidates[0]?.placeName ?? placeSlug,
      selected: selected.map((entry) => entry.candidate),
      alternatives: restaurantCandidates.filter((candidate) => groups.length === 0 || groups.some((group) =>
        evaluateIntentGroup(group, candidate.normalized, candidateText(candidate)).intentCoverage > 0
      )),
      matchedGroups: selected.length,
      fullGroups: selected.filter((entry) => entry.match.matchedIntent).length,
      coverageScore: selected.reduce((total, entry) => total + entry.match.intentCoverage, 0),
      score: groups.length === 0
        ? restaurantCandidates.slice(0, limit).reduce((total, candidate) => total + candidate.score, 0)
        : selected.reduce((total, entry) => total + entry.candidate.score, 0),
    };
  }).sort((left, right) =>
    right.coverageScore - left.coverageScore ||
    right.fullGroups - left.fullGroups ||
    right.matchedGroups - left.matchedGroups ||
    right.score - left.score ||
    left.placeName.localeCompare(right.placeName)
  );

  const best = ranked[0];
  if (!best || (best.matchedGroups === 0 && groups.length > 0)) return undefined;
  const selected = [...best.selected];
  if (groups.length <= 1) {
    for (const candidate of best.alternatives) {
      if (!selected.includes(candidate)) selected.push(candidate);
    }
  }
  return {
    results: selected.slice(0, limit),
    ...(groups.length > 0 ? { restaurantCoverage: {
      placeSlug: best.placeSlug,
      placeName: best.placeName,
      matchedGroups: best.matchedGroups,
      totalGroups: groups.length,
      coverage: round(best.coverageScore / groups.length),
    } } : {}),
  };
}

function applyIntentGroups(candidate: DishCandidate, groups: RecommendationIntentGroup[]): DishCandidate {
  if (groups.length === 0) return candidate;
  const matches = groups.map((group) =>
    evaluateIntentGroup(group, candidate.normalized, candidateText(candidate))
  );
  const matchedIntents = matches.filter((match) => match.matchedIntent).map((match) => match.intent);
  return {
    ...candidate,
    matchedTerms: unique(matches.flatMap((match) => match.matchedTerms)),
    intentCoverage: Math.max(...matches.map((match) => match.intentCoverage)),
    matchedIntent: matchedIntents.length > 0,
    intentMatches: matches,
    matchedIntents,
  };
}

function candidateText(
  candidate: Pick<FoodResult, "name" | "searchName" | "description" | "menuCategories">,
): string {
  return [candidate.name, candidate.searchName, candidate.description, ...candidate.menuCategories].filter(Boolean).join(" ");
}

function uniqueQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  return queries.map((query) => query.trim()).filter((query) => {
    const normalized = normalizeText(query);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function parseRating(value?: string): number | undefined {
  if (!value) return undefined;
  const rating = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(rating) ? rating : undefined;
}

function ratingSignal(value?: number): number {
  return value === undefined ? 0.55 : Math.max(0, Math.min(1, (value - 3.5) / 1.5));
}

function round(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}
