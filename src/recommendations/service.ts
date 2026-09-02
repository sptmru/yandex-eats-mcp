import type { Logger } from "pino";
import type { YandexEatsClient } from "../eats/client.js";
import type { NormalizedMenu, NormalizedMenuCategory, NormalizedSearch } from "../eats/schemas.js";
import { diversifyResults } from "./diversify.js";
import { expandSearchIntents } from "./intents.js";
import { normalizeDish, normalizeText } from "./normalize.js";
import { calculateRelevance, scoreCandidate } from "./scoring.js";
import type {
  DishCandidate,
  FoodResult,
  FoodSearchResult,
  RecommendFoodInput,
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
};

const DEFAULT_OPTIONS: RecommendationOptions = {
  maxIntents: 6,
  maxMenus: 12,
  maxPagesPerQuery: 2,
  menuConcurrency: 3,
  menuCacheTtlMs: 5 * 60_000,
};

export class RecommendationService {
  private readonly menuCache = new Map<string, { loadedAt: number; menu: NormalizedMenu }>();

  constructor(
    private readonly client: YandexEatsClient,
    private readonly preferences: FoodPreferenceStore,
    private readonly logger: Logger,
    private readonly options: RecommendationOptions = DEFAULT_OPTIONS,
  ) {}

  async initialize(): Promise<void> {
    await this.preferences.initialize();
  }

  async searchItems(input: SearchItemsInput): Promise<FoodSearchResult> {
    const queries = uniqueQueries(input.queries).slice(0, this.options.maxIntents);
    const gathered = await this.gatherCandidates({
      queries,
      maxPlaces: Math.min(input.maxPlaces ?? this.options.maxMenus, this.options.maxMenus),
      maxPagesPerQuery: Math.min(input.maxPagesPerQuery ?? this.options.maxPagesPerQuery, this.options.maxPagesPerQuery),
    });
    const maxItems = input.maxItems ?? 50;
    const results = gathered.candidates
      .map((candidate) => ({
        ...stripRelevance(candidate),
        score: round(candidate.relevance * 0.85 + ratingSignal(candidate.rating) * 0.15),
        scoreReasons: [
          candidate.relevance >= 0.65 ? "strong item match" : "relevant menu match",
          ...(candidate.rating !== undefined ? [`restaurant rating ${candidate.rating}`] : []),
        ],
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    return {
      queries,
      candidatePlaces: gathered.candidatePlaces,
      menusLoaded: gathered.menusLoaded,
      results: input.deduplicate === false ? results.slice(0, maxItems) : deduplicateResults(results).slice(0, maxItems),
      warnings: gathered.warnings,
    };
  }

  async recommend(input: RecommendFoodInput): Promise<RecommendationResult> {
    const searchIntents = expandSearchIntents({
      query: input.query,
      ...(input.categories ? { categories: input.categories } : {}),
      ...(input.prefer ? { prefer: input.prefer } : {}),
      maxIntents: this.options.maxIntents,
    });
    const gathered = await this.gatherCandidates({
      queries: searchIntents,
      maxPlaces: this.options.maxMenus,
      maxPagesPerQuery: this.options.maxPagesPerQuery,
    });
    const preferences = await this.preferences.list();
    const scored = gathered.candidates
      .map((candidate) => scoreCandidate(candidate, input, preferences))
      .filter((candidate): candidate is FoodResult => candidate !== undefined)
      .sort((a, b) => b.score - a.score);
    const limit = input.limit ?? 10;
    const results = diversifyResults(deduplicateResults(scored), {
      limit,
      maxPerRestaurant: input.maxPerRestaurant ?? 2,
      maxPerCategory: input.maxPerCategory ?? 2,
      exploration: input.exploration ?? 0.35,
    });

    return {
      query: input.query,
      searchIntents,
      candidatePlaces: gathered.candidatePlaces,
      menusLoaded: gathered.menusLoaded,
      results,
      warnings: gathered.warnings,
    };
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
  }): Promise<{ candidates: DishCandidate[]; candidatePlaces: number; menusLoaded: number; warnings: string[] }> {
    const places = new Map<string, PlaceEvidence>();
    for (const query of input.queries) {
      let cursor: string | undefined;
      for (let page = 0; page < input.maxPagesPerQuery; page += 1) {
        const search = await this.client.search({
          query,
          maxPlaces: 50,
          maxItemsPerPlace: 25,
          ...(cursor ? { cursor } : {}),
        });
        mergeSearchEvidence(places, search, query);
        cursor = search.cursor;
        if (!cursor) break;
      }
    }

    const rankedPlaces = selectDiversePlaces([...places.values()], input.queries, input.maxPlaces);
    const warnings: string[] = [];
    let menusLoaded = 0;
    const menuResults = await mapLimit(rankedPlaces, this.options.menuConcurrency, async (place) => {
      try {
        const menu = await this.loadMenu(place.placeSlug);
        menusLoaded += 1;
        return { place, menu };
      } catch (error) {
        this.logger.warn({ err: error, placeSlug: place.placeSlug }, "Recommendation menu load failed");
        warnings.push(`Could not load the current menu for ${place.name}.`);
        return undefined;
      }
    });

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
        const intentScores = input.queries.map((query) => ({
          query,
          relevance: searchEvidence?.queries.has(query)
            ? 0.95
            : calculateRelevance({
            name: [item.name, searchName].filter(Boolean).join(" "),
            ...(item.description ? { description: item.description } : {}),
            menuCategories: item.menuCategories,
            query,
            normalized,
          }),
        }));
        const matchedIntents = intentScores.filter((entry) => entry.relevance >= 0.2).map((entry) => entry.query);
        if (matchedIntents.length === 0) continue;
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
          matchedIntents,
          relevance,
        });
      }
    }

    return {
      candidates: deduplicateCandidates(candidates),
      candidatePlaces: places.size,
      menusLoaded,
      warnings,
    };
  }

  private async loadMenu(placeSlug: string): Promise<NormalizedMenu> {
    const cached = this.menuCache.get(placeSlug);
    if (cached && Date.now() - cached.loadedAt < this.options.menuCacheTtlMs) return cached.menu;
    const menu = await this.client.getMenu({ placeSlug });
    this.menuCache.set(placeSlug, { loadedAt: Date.now(), menu });
    return menu;
  }
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

function selectDiversePlaces(places: PlaceEvidence[], queries: string[], limit: number): PlaceEvidence[] {
  const ranked = [...places].sort((left, right) => placeEvidenceScore(right) - placeEvidenceScore(left));
  const selected: PlaceEvidence[] = [];
  const selectedSlugs = new Set<string>();

  while (selected.length < limit) {
    let added = false;
    for (const query of queries) {
      const candidate = ranked.find(
        (place) =>
          !selectedSlugs.has(place.placeSlug) &&
          [...place.searchItems.values()].some((item) => item.queries.has(query)),
      );
      if (!candidate) continue;
      selected.push(candidate);
      selectedSlugs.add(candidate.placeSlug);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }

  for (const place of ranked) {
    if (selected.length >= limit) break;
    if (selectedSlugs.has(place.placeSlug)) continue;
    selected.push(place);
    selectedSlugs.add(place.placeSlug);
  }
  return selected;
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

function uniqueQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  return queries.map((query) => query.trim()).filter((query) => {
    const normalized = normalizeText(query);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function parseRating(value?: string): number | undefined {
  if (!value) return undefined;
  const rating = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(rating) ? rating : undefined;
}

function ratingSignal(value?: number): number {
  return value === undefined ? 0.55 : Math.max(0, Math.min(1, (value - 3.5) / 1.5));
}

function stripRelevance(candidate: DishCandidate): Omit<DishCandidate, "relevance"> {
  const { relevance, ...result } = candidate;
  void relevance;
  return result;
}

function round(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}
