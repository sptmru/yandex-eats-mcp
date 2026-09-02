import { canonicalValues, normalizeText, termMatchesDish, tokenize } from "./normalize.js";
import type { DishCandidate, FoodPreference, FoodResult, RecommendFoodInput } from "./types.js";

export function scoreCandidate(
  candidate: DishCandidate,
  input: RecommendFoodInput,
  preferences: FoodPreference[],
): FoodResult | undefined {
  const text = [candidate.name, candidate.searchName, candidate.description, ...candidate.menuCategories].filter(Boolean).join(" ");
  if (input.maxPrice !== undefined && candidate.price > input.maxPrice) return undefined;
  if (input.maxHeaviness !== undefined && candidate.normalized.heaviness > input.maxHeaviness) return undefined;
  if ((input.avoid ?? []).some((term) => termMatchesDish(term, candidate.normalized, text))) return undefined;
  if (input.categories?.length && !input.categories.some((term) => termMatchesDish(term, candidate.normalized, text))) {
    return undefined;
  }

  const reasons: string[] = [];
  let score = candidate.relevance * 0.22 + candidate.intentCoverage * 0.2;
  if (candidate.matchedIntent) reasons.push("full intent match");
  else if (candidate.intentCoverage > 0) reasons.push(`partial intent match (${candidate.intentCoverage})`);

  const ratingSignal = candidate.rating === undefined ? 0.55 : clamp((candidate.rating - 3.5) / 1.5);
  score += ratingSignal * 0.13;
  if (candidate.rating !== undefined && candidate.rating >= 4.6) reasons.push(`restaurant rating ${candidate.rating}`);

  const preferred = uniqueSemanticTerms(input.prefer ?? []).filter((term) => termMatchesDish(term, candidate.normalized, text));
  if (preferred.length > 0) {
    score += Math.min(0.18, preferred.length * 0.09);
    reasons.push(`preferred: ${preferred.slice(0, 3).join(", ")}`);
  }

  if (input.maxPrice !== undefined) {
    const headroom = clamp(1 - candidate.price / input.maxPrice);
    score += (0.06 + headroom * 0.04);
    reasons.push(`within price limit (${candidate.price} ${candidate.currency})`);
  } else {
    score += 0.05;
  }

  if (input.maxHeaviness !== undefined) {
    const fit = clamp(1 - candidate.normalized.heaviness / Math.max(input.maxHeaviness, 0.01));
    score += 0.06 + fit * 0.07;
    reasons.push(`heaviness ${candidate.normalized.heaviness}`);
  } else if (/(light|healthy|л[её]гк\p{L}*|полезн\p{L}*)/iu.test(input.query)) {
    score += (1 - candidate.normalized.heaviness) * 0.13;
    reasons.push(`lighter profile (${candidate.normalized.heaviness})`);
  } else {
    score += 0.06;
  }

  const preference = findPreference(candidate, preferences);
  if (preference?.liked === false) return undefined;
  if (preference?.liked === true) {
    score += 0.09;
    reasons.push("previously liked");
  }
  if (preference?.rating !== undefined) {
    score += ((preference.rating - 3) / 2) * 0.05;
    reasons.push(`your rating ${preference.rating}/5`);
  }

  const exploration = input.exploration ?? 0.35;
  const orderCount = preference?.orderCount ?? 0;
  const novelty = 1 / (1 + orderCount);
  score += novelty * exploration * 0.12;
  if (exploration >= 0.5 && orderCount === 0) reasons.push("novel option");
  if (candidate.promos.length > 0) {
    score += 0.02;
    reasons.push("promotion available");
  }

  return {
    ...stripRelevance(candidate),
    score: round(clamp(score)),
    scoreReasons: reasons.slice(0, 6),
  };
}

export function calculateRelevance(input: {
  name: string;
  description?: string;
  menuCategories: string[];
  query: string;
  normalized: DishCandidate["normalized"];
}): number {
  const name = normalizeText(input.name);
  const description = normalizeText(input.description ?? "");
  const categories = normalizeText(input.menuCategories.join(" "));
  const tokens = tokenize(input.query);
  const canonicalMatch = termMatchesDish(input.query, input.normalized, `${name} ${description} ${categories}`);
  if (tokens.length === 0) return canonicalMatch ? 0.75 : 0;

  let matched = 0;
  let weighted = 0;
  for (const token of tokens) {
    if (name.includes(token)) {
      matched += 1;
      weighted += 1;
    } else if (description.includes(token)) {
      matched += 1;
      weighted += 0.65;
    } else if (categories.includes(token) || termMatchesDish(token, input.normalized, "")) {
      matched += 1;
      weighted += 0.75;
    }
  }
  const coverage = matched / tokens.length;
  return round(clamp(weighted / tokens.length * 0.75 + coverage * 0.15 + (canonicalMatch ? 0.1 : 0)));
}

function findPreference(candidate: DishCandidate, preferences: FoodPreference[]): FoodPreference | undefined {
  return preferences.find(
    (entry) => entry.placeSlug === candidate.placeSlug && entry.itemId === candidate.itemId,
  ) ?? preferences.find(
    (entry) => entry.placeSlug === candidate.placeSlug && entry.itemId === undefined,
  );
}

function stripRelevance(candidate: DishCandidate): Omit<DishCandidate, "relevance"> {
  const { relevance, ...result } = candidate;
  void relevance;
  return result;
}

function uniqueSemanticTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  return terms.filter((term) => {
    const canonical = canonicalValues(term);
    const key = canonical.length > 0 ? [...canonical].sort().join("|") : normalizeText(term);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
