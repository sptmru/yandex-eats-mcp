import { canonicalValues, normalizeText, tokenize } from "./normalize.js";
import type { IntentMatch, NormalizedDish, RecommendationIntentGroup } from "./types.js";

const LIGHT = /(light|healthy|not too heavy|л[её]гк\p{L}*|не тяжел\p{L}*|полезн\p{L}*)/iu;
const FILLING = /(filling|substantial|satisfying|сытн\p{L}*|насыт\p{L}*)/iu;
const VARIED = /(varied|diverse|different|variety|разн\p{L}*|разнообраз\p{L}*)/iu;
const CYRILLIC = /\p{Script=Cyrillic}/u;

const SEARCH_TERMS: Record<string, { en: string; ru: string }> = {
  soup: { en: "soup", ru: "суп" },
  salad: { en: "salad", ru: "салат" },
  fish: { en: "fish", ru: "рыба" },
  seafood: { en: "seafood", ru: "морепродукты" },
  poke: { en: "poke", ru: "поке" },
  bowl: { en: "bowl", ru: "боул" },
  grilled: { en: "grilled fish", ru: "рыба на гриле" },
  steamed: { en: "steamed", ru: "на пару" },
  chicken: { en: "chicken bowl", ru: "боул с курицей" },
  meat: { en: "meat", ru: "мясо" },
  fried: { en: "fried", ru: "жареное" },
  beef: { en: "beef", ru: "говядина" },
  pork: { en: "pork", ru: "свинина" },
  lamb: { en: "lamb", ru: "баранина" },
};

const FISH_PROTEINS = new Set(["salmon", "trout", "tuna", "white fish"]);
const SEAFOOD_PROTEINS = new Set(["shrimp", "crab", "mussels", "squid"]);
const MEAT_PROTEINS = new Set(["chicken", "beef", "pork", "lamb"]);
const MODIFIER_TERMS = new Set([
  "light",
  "filling",
  "spicy",
  "vegetarian",
  "fried",
  "grilled",
  "steamed",
  "baked",
  "raw",
  "boiled",
  "stewed",
  "smoked",
]);

export function expandSearchIntents(input: {
  query: string;
  categories?: string[];
  prefer?: string[];
  maxIntents?: number;
}): string[] {
  const query = input.query.trim();
  const language = CYRILLIC.test(query) ? "ru" : "en";
  const explicit = [...(input.categories ?? []), ...(input.prefer ?? [])];
  const canonical = new Set([...canonicalValues(query), ...explicit.flatMap(canonicalValues)]);
  const intents: string[] = [];

  for (const value of explicit.filter((entry) => canonicalValues(entry).length === 0)) add(intents, value);
  for (const value of canonical) add(intents, SEARCH_TERMS[value]?.[language] ?? value);

  if (LIGHT.test(query)) {
    for (const value of FILLING.test(query)
      ? ["bowl", "poke", "soup", "grilled", "salad", "chicken"]
      : ["salad", "soup", "poke", "fish", "seafood"]) {
      add(intents, SEARCH_TERMS[value]?.[language] ?? value);
    }
  }

  if (VARIED.test(query) && intents.length < 4) {
    for (const value of ["fish", "seafood", "salad", "soup", "poke"]) {
      add(intents, SEARCH_TERMS[value]?.[language] ?? value);
    }
  }

  const contentTokens = tokenize(query);
  if (intents.length === 0 && contentTokens.length > 0) add(intents, query);
  if (intents.length === 0) add(intents, language === "ru" ? "еда" : "food");
  return intents.slice(0, input.maxIntents ?? 6);
}

function add(values: string[], value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  const key = intentKey(trimmed);
  if (!values.some((entry) => intentKey(entry) === key)) values.push(trimmed);
}

export function evaluateIntent(intent: string, dish: NormalizedDish, text: string): IntentMatch {
  const extracted = extractIntentTerms(intent);
  const terms = extracted.length > 0 ? extracted : tokenize(intent);
  return evaluateTerms(intent, terms, dish, text);
}

export function evaluateIntentGroup(
  group: RecommendationIntentGroup,
  dish: NormalizedDish,
  text: string,
): IntentMatch {
  const alternatives = group.alternatives.map((terms) => evaluateTerms(group.label, terms, dish, text));
  const best = alternatives.sort((left, right) =>
    Number(right.matchedIntent) - Number(left.matchedIntent) ||
    right.intentCoverage - left.intentCoverage ||
    right.matchedTerms.length - left.matchedTerms.length
  )[0];
  return best ? { ...best, intentCoverage: round(best.intentCoverage) } : {
    intent: group.label,
    requiredTerms: [],
    modifierTerms: [],
    matchedTerms: [],
    intentCoverage: 0,
    matchedIntent: false,
  };
}

export function parseRecommendationIntentGroups(query: string): {
  groups: RecommendationIntentGroup[];
  sameRestaurant: boolean;
} {
  const sameRestaurant = /(same restaurant|one restaurant|one place|из одного (?:ресторана|места)|в одном (?:ресторане|месте))/iu.test(query);
  const afterColon = query.includes(":") ? query.slice(query.indexOf(":") + 1) : query;
  const possibleGroups = afterColon.split(/[,;]+/u).map((entry) => entry.trim()).filter(Boolean);
  const hasPersonMarkers = possibleGroups.filter(hasPersonMarker).length >= 1 && possibleGroups.length >= 2;
  const implicitSameRestaurantGroups = sameRestaurant && possibleGroups.length >= 2 &&
    !/\s+(?:или|либо|or)\s+|\s*\/\s*/iu.test(afterColon);
  const hasGroupBoundaries = hasPersonMarkers || implicitSameRestaurantGroups;
  const segments = hasPersonMarkers
    ? mergePersonSegments(possibleGroups)
    : implicitSameRestaurantGroups ? possibleGroups : [afterColon.trim()];
  const groups = segments.map((segment, index) => {
    const { label, request } = stripPersonMarker(segment, index);
    const context = hasGroupBoundaries ? request : query;
    const { alternatives, sharedQualifierTerms } = splitAlternativePhrases(request);
    const commonTerms = extractCommonModifierTerms(context);
    return {
      id: `group-${index + 1}`,
      label,
      alternatives: alternatives.map((alternative) => {
        const terms = extractIntentTerms(alternative).filter((term) => !commonTerms.includes(term));
        const fallback = terms.length === 0 ? tokenize(alternative).slice(0, 3) : terms;
        return unique([...fallback, ...sharedQualifierTerms, ...commonTerms]);
      }).filter((terms) => terms.length > 0),
    };
  }).filter((group) => group.alternatives.length > 0);

  return { groups, sameRestaurant };
}

export function extractIntentTerms(value: string): string[] {
  const canonical = canonicalValues(value);
  const proteins = canonical.filter((entry) =>
    FISH_PROTEINS.has(entry) || SEAFOOD_PROTEINS.has(entry) || MEAT_PROTEINS.has(entry),
  );
  const terms = canonical.filter((entry) => {
    if (entry === "fish" && proteins.some((protein) => FISH_PROTEINS.has(protein))) return false;
    if (entry === "seafood" && proteins.some((protein) => SEAFOOD_PROTEINS.has(protein))) return false;
    if (entry === "meat" && proteins.some((protein) => MEAT_PROTEINS.has(protein))) return false;
    return true;
  });
  if (LIGHT.test(value)) terms.push("light");
  if (FILLING.test(value)) terms.push("filling");
  if (/(spicy|hot|остр\p{L}*)/iu.test(value)) terms.push("spicy");
  if (/(vegetarian|vegan|plant based|вегетариан\p{L}*|веган\p{L}*)/iu.test(value)) terms.push("vegetarian");
  return unique(terms);
}

function evaluateTerms(intent: string, terms: string[], dish: NormalizedDish, text: string): IntentMatch {
  const requiredTerms = terms.filter((term) => !MODIFIER_TERMS.has(term)).slice(0, 1);
  const modifierTerms = terms.filter((term) => !requiredTerms.includes(term));
  const matchedRequiredTerms = requiredTerms.filter((term) => termMatches(term, dish, text));
  const requiredSatisfied = requiredTerms.length === 0 || matchedRequiredTerms.length === requiredTerms.length;
  const matchedModifierTerms = modifierTerms.filter((term) => termMatches(term, dish, text));
  const matchedSet = new Set([...matchedRequiredTerms, ...matchedModifierTerms]);
  const matchedTerms = requiredSatisfied ? terms.filter((term) => matchedSet.has(term)) : [];
  const intentCoverage = requiredSatisfied && terms.length > 0 ? matchedTerms.length / terms.length : 0;

  return {
    intent,
    requiredTerms,
    modifierTerms,
    matchedTerms,
    intentCoverage: round(intentCoverage),
    matchedIntent: terms.length > 0 && requiredSatisfied && matchedTerms.length === terms.length,
  };
}

function termMatches(term: string, dish: NormalizedDish, text: string): boolean {
  if (term === "light") return dish.heaviness < 0.45;
  if (term === "filling") return dish.heaviness >= 0.55;
  if (term === "spicy") return dish.spicy;
  if (term === "vegetarian") return dish.vegetarian;
  if (term === "fish") return dish.categories.includes("fish") || dish.proteins.some((entry) => FISH_PROTEINS.has(entry));
  if (term === "seafood") return dish.categories.includes("seafood") || dish.proteins.some((entry) => SEAFOOD_PROTEINS.has(entry));
  if (term === "meat") return dish.categories.includes("meat") || dish.proteins.some((entry) => MEAT_PROTEINS.has(entry));
  if (FISH_PROTEINS.has(term) || SEAFOOD_PROTEINS.has(term) || MEAT_PROTEINS.has(term)) {
    return dish.proteins.includes(term);
  }
  const directMatch =
    dish.categories.includes(term) ||
    dish.proteins.includes(term) ||
    dish.cookingMethods.includes(term) ||
    dish.cuisines.includes(term);
  if (directMatch) return true;
  const canonical = canonicalValues(term);
  if (canonical.includes(term)) return false;
  return canonical.some((value) =>
    dish.categories.includes(value) ||
    dish.proteins.includes(value) ||
    dish.cookingMethods.includes(value) ||
    dish.cuisines.includes(value)
  ) || normalizeText(text).split(" ").includes(normalizeText(term));
}

function extractCommonModifierTerms(value: string): string[] {
  return unique([
    ...(LIGHT.test(value) ? ["light"] : []),
    ...(FILLING.test(value) ? ["filling"] : []),
    ...(/(spicy|hot|остр\p{L}*)/iu.test(value) ? ["spicy"] : []),
    ...(/(vegetarian|vegan|plant based|вегетариан\p{L}*|веган\p{L}*)/iu.test(value) ? ["vegetarian"] : []),
  ]);
}

function splitAlternativePhrases(request: string): {
  alternatives: string[];
  sharedQualifierTerms: string[];
} {
  const cleaned = request.replace(/[.?!]+$/u, "").trim();
  const hasAlternativeOperator = /\s+(?:или|либо|or)\s+|\s*\/\s*/iu.test(cleaned);
  const hasCommaList = /[,;]/u.test(cleaned);
  let alternatives = cleaned
    .split(/[,;]+|\s+(?:или|либо|or)\s+|\s*\/\s*/iu)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (hasCommaList || /(?:что(?:-?нибудь)?|что-то|something|anything)\s+(?:из|from|of)\b/iu.test(cleaned)) {
    alternatives = alternatives.flatMap(splitEnumeratedConjunction);
  }

  const sharedQualifierTerms: string[] = [];
  if (hasAlternativeOperator && alternatives.length > 1) {
    const lastIndex = alternatives.length - 1;
    const last = alternatives[lastIndex];
    const qualifier = last?.match(/^(.*?)\s+(?:с|with)\s+(.+)$/iu);
    if (qualifier?.[1] && qualifier[2]) {
      const terms = extractIntentTerms(qualifier[2]);
      const fallback = terms.length === 0 ? tokenize(qualifier[2]).slice(0, 3) : terms;
      if (fallback.length > 0) {
        alternatives[lastIndex] = qualifier[1].trim();
        sharedQualifierTerms.push(...fallback);
      }
    }
  }

  return { alternatives: alternatives.filter(Boolean), sharedQualifierTerms: unique(sharedQualifierTerms) };
}

function splitEnumeratedConjunction(value: string): string[] {
  const parts = value.split(/\s+(?:и|and)\s+/iu).map((entry) => entry.trim()).filter(Boolean);
  if (parts.length < 2) return [value];
  const allAreKnownConcepts = parts.every((part) =>
    extractIntentTerms(part).some((term) => !MODIFIER_TERMS.has(term))
  );
  return allAreKnownConcepts ? parts : [value];
}

function mergePersonSegments(segments: string[]): string[] {
  const merged: string[] = [];
  for (const segment of segments) {
    if (hasPersonMarker(segment) || merged.length === 0) {
      merged.push(segment);
      continue;
    }
    const lastIndex = merged.length - 1;
    const previous = merged[lastIndex];
    if (previous !== undefined) merged[lastIndex] = `${previous}, ${segment}`;
  }
  return merged;
}

function intentKey(value: string): string {
  const terms = extractIntentTerms(value);
  return terms.length > 0 ? [...terms].sort().join("|") : normalizeText(value);
}

function hasPersonMarker(value: string): boolean {
  return PERSON_MARKER.test(value);
}

function stripPersonMarker(value: string, index: number): { label: string; request: string } {
  const match = value.match(PERSON_MARKER_WITH_SPACE);
  if (!match?.[1]) return { label: value || `group ${index + 1}`, request: value };
  return { label: match[1], request: value.slice(match[0].length) };
}

const PERSON_MARKER_SOURCE = String.raw`(?:мне|нам|ему|ей|тебе|одному|другому|первому|второму|первой|второй|for\s+\p{L}+|для\s+\p{L}+|(?!(?:Хочу|Ищу|Буду)\b)[А-ЯЁ][а-яё]+(?:е|у))`;
const PERSON_MARKER = new RegExp(`^${PERSON_MARKER_SOURCE}(?=\\s|$)`, "u");
const PERSON_MARKER_WITH_SPACE = new RegExp(`^(${PERSON_MARKER_SOURCE})\\s+`, "u");

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
