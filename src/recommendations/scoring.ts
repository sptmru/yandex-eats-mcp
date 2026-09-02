import { canonicalValues, normalizeText, termMatchesDish, tokenize } from "./normalize.js";
import type { DishCandidate, FoodPreference, FoodResult, RecommendFoodInput } from "./types.js";

export function scoreSearchCandidate(candidate: DishCandidate, queries: string[]): FoodResult {
  const bestIntent = [...candidate.intentMatches].sort((left, right) =>
    Number(right.matchedIntent) - Number(left.matchedIntent) || right.intentCoverage - left.intentCoverage
  )[0];
  const intentSignal = bestIntent?.matchedIntent ? 1 : (bestIntent?.intentCoverage ?? 0);
  const lexical = bestLexicalNameMatch(candidate, queries);
  const semanticSignal = bestIntent?.requiredTerms.length
    ? Number(bestIntent.requiredTerms.every((term) => bestIntent.matchedTerms.includes(term)))
    : intentSignal;
  const heavinessSignal = queryHeavinessSignal(queries, candidate.normalized.heaviness);
  const weightSignal = queryWeightSignal(queries, candidate.weight);
  const ratingSignal = candidate.rating === undefined ? 0.55 : clamp((candidate.rating - 3.5) / 1.5);
  const eta = etaSignal(candidate.eta);
  const score = candidate.relevance * 0.28 +
    intentSignal * 0.22 +
    lexical.signal * 0.18 +
    semanticSignal * 0.1 +
    heavinessSignal * 0.07 +
    weightSignal * 0.04 +
    ratingSignal * 0.07 +
    eta * 0.04;
  const reasons = [
    bestIntent?.matchedIntent ? "full intent match" : `partial intent match (${bestIntent?.intentCoverage ?? 0})`,
    ...(lexical.signal === 1 ? [lexical.source === "searchName" ? "exact translated-name match" : "exact name match"] : []),
    ...(semanticSignal === 1 && bestIntent?.requiredTerms.length ? [`required concept: ${bestIntent.requiredTerms.join(", ")}`] : []),
    ...(heavinessSignal !== 0.5 ? [`heaviness fit (${candidate.normalized.heaviness})`] : []),
    ...(weightSignal !== 0.5 && candidate.weight ? [`weight fit (${candidate.weight})`] : []),
    ...(candidate.rating !== undefined ? [`restaurant rating ${candidate.rating}`] : []),
    ...(candidate.eta && eta > 0.5 ? [`delivery ETA ${candidate.eta}`] : []),
  ];

  return {
    ...stripRelevance(candidate),
    score: round(clamp(score)),
    scoreReasons: reasons.slice(0, 6),
  };
}

export function scoreCandidate(
  candidate: DishCandidate,
  input: RecommendFoodInput,
  preferences: FoodPreference[],
): FoodResult | undefined {
  const text = [candidate.name, candidate.searchName, candidate.description, ...candidate.menuCategories].filter(Boolean).join(" ");
  if (input.maxPrice !== undefined && candidate.price > input.maxPrice) return undefined;
  if (input.maxHeaviness !== undefined && candidate.normalized.heaviness > input.maxHeaviness) return undefined;
  if (candidate.intentMatches.some((match) => match.matchedExcludedTerms.length > 0)) return undefined;
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

function bestLexicalNameMatch(
  candidate: DishCandidate,
  queries: string[],
): { signal: number; source: "name" | "searchName" } {
  let best: { signal: number; source: "name" | "searchName" } = { signal: 0, source: "name" };
  for (const query of queries) {
    for (const [source, name] of [["name", candidate.name], ["searchName", candidate.searchName]] as const) {
      if (!name) continue;
      const signal = lexicalNameSignal(name, query);
      if (signal > best.signal) best = { signal, source };
    }
  }
  return best;
}

function lexicalNameSignal(name: string, query: string): number {
  const normalizedName = normalizeText(name);
  const normalizedQuery = normalizeText(query);
  if (!normalizedName || !normalizedQuery) return 0;
  if (normalizedName === normalizedQuery) return 1;
  const nameTokens = tokenize(name);
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || nameTokens.length === 0) return 0;
  const matched = queryTokens.filter((queryToken) =>
    nameTokens.some((nameToken) => nameToken.startsWith(queryToken) || queryToken.startsWith(nameToken)),
  ).length;
  const coverage = matched / queryTokens.length;
  const compactness = Math.min(1, queryTokens.length / nameTokens.length);
  return clamp(coverage * (0.65 + compactness * 0.35));
}

function queryHeavinessSignal(queries: string[], heaviness: number): number {
  const query = queries.join(" ");
  if (/(light|healthy|not too heavy|л[её]гк\p{L}*|не тяжел\p{L}*|полезн\p{L}*)/iu.test(query)) {
    return 1 - heaviness;
  }
  if (/(filling|substantial|satisfying|сытн\p{L}*|насыт\p{L}*)/iu.test(query)) return heaviness;
  return 0.5;
}

function queryWeightSignal(queries: string[], weight?: string): number {
  if (!weight) return 0.5;
  const grams = parseWeightGrams(weight);
  if (grams === undefined) return 0.5;
  const query = queries.join(" ");
  if (/(light|healthy|not too heavy|л[её]гк\p{L}*|не тяжел\p{L}*|полезн\p{L}*)/iu.test(query)) {
    return clamp(1 - grams / 700);
  }
  if (/(filling|substantial|satisfying|сытн\p{L}*|насыт\p{L}*)/iu.test(query)) return clamp(grams / 600);
  return 0.5;
}

function parseWeightGrams(weight: string): number | undefined {
  const normalized = weight.replace(",", ".");
  const amount = Number.parseFloat(normalized.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(amount)) return undefined;
  return /\bkg\b|кг/iu.test(normalized) ? amount * 1000 : amount;
}

function etaSignal(eta?: string): number {
  if (!eta) return 0.5;
  const minutes = Number.parseInt(eta.match(/\d+/u)?.[0] ?? "", 10);
  if (!Number.isFinite(minutes)) return 0.5;
  return clamp(1 - (minutes - 15) / 60);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
