import { canonicalValues, normalizeText, tokenize } from "./normalize.js";

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
};

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

  for (const value of explicit) add(intents, value);
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
  const normalized = normalizeText(trimmed);
  if (!values.some((entry) => normalizeText(entry) === normalized)) values.push(trimmed);
}
