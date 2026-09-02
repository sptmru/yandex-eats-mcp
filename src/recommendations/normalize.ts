import type { NormalizedDish } from "./types.js";

type Rule = { value: string; patterns: RegExp[] };

const CATEGORY_RULES: Rule[] = [
  rule("soup", "soup", "bisque", "broth", "ramen", "pho", "суп", "бульон", "солянк", "борщ", "щи", "том ям"),
  rule("salad", "salad", "caesar", "салат", "цезар"),
  rule("fish", "fish", "salmon", "trout", "tuna", "cod", "seabass", "дорадо", "рыб", "лосос", "семг", "сёмг", "форел", "тунц", "треск"),
  rule("seafood", "seafood", "shrimp", "prawn", "mussel", "squid", "octopus", "crab", "морепродукт", "кревет", "мид", "кальмар", "осьминог", "краб"),
  rule("poke", "poke", "поке"),
  rule("bowl", "bowl", "боул"),
  rule("main", "main course", "steak", "стейк", "горячее", "основное блюдо"),
  rule("sandwich", "sandwich", "burger", "wrap", "шаурм", "бургер", "сэндвич", "ролл"),
  rule("pasta", "pasta", "spaghetti", "паста", "спагетти"),
  rule("pizza", "pizza", "пицц"),
  rule("breakfast", "breakfast", "omelet", "omelette", "завтрак", "омлет", "сырник"),
  rule("dessert", "dessert", "cake", "brownie", "cheesecake", "десерт", "тортик", "брауни", "чизкейк"),
  rule("snack", "snack", "starter", "appetizer", "закуск", "снэк"),
];

const PROTEIN_RULES: Rule[] = [
  rule("salmon", "salmon", "лосос", "семг", "сёмг"),
  rule("trout", "trout", "форел"),
  rule("tuna", "tuna", "тунец", "тунц"),
  rule("white fish", "cod", "seabass", "dorade", "дорадо", "треск", "сибас", "белая рыба"),
  rule("shrimp", "shrimp", "prawn", "кревет"),
  rule("crab", "crab", "краб"),
  rule("mussels", "mussel", "мид"),
  rule("squid", "squid", "calamari", "кальмар"),
  rule("chicken", "chicken", "turkey", "куриц", "цыплен", "индейк"),
  rule("beef", "beef", "veal", "говядин", "телят"),
  rule("pork", "pork", "bacon", "свинин", "бекон"),
  rule("lamb", "lamb", "mutton", "баранин", "ягнен"),
  rule("egg", "egg", "яйц", "омлет"),
  rule("tofu", "tofu", "тофу"),
  rule("legumes", "lentil", "chickpea", "bean", "нут", "чечевиц", "фасол"),
];

const METHOD_RULES: Rule[] = [
  rule("grilled", "grill", "grilled", "charcoal", "грил", "на углях"),
  rule("steamed", "steam", "steamed", "на пару", "паровой"),
  rule("fried", "fried", "deep-fried", "tempura", "crispy", "фри", "жарен", "темпур", "хрустящ"),
  rule("baked", "baked", "roasted", "oven", "запеч", "печен", "из печи"),
  rule("raw", "raw", "sashimi", "tartare", "carpaccio", "сырой", "сашими", "тартар", "карпаччо"),
  rule("boiled", "boiled", "poached", "варен", "варён", "отварн", "пашот"),
  rule("stewed", "stew", "braised", "тушен", "тушён"),
];

const CUISINE_RULES: Rule[] = [
  rule("japanese", "japanese", "sushi", "ramen", "япон", "суши", "рамен"),
  rule("italian", "italian", "pasta", "pizza", "итальян", "паста", "пицц"),
  rule("georgian", "georgian", "khinkali", "khachapuri", "грузин", "хинкал", "хачапур"),
  rule("armenian", "armenian", "lavash", "khorovats", "армян", "лаваш", "хоровац"),
  rule("asian", "asian", "thai", "vietnamese", "азиат", "тайск", "вьетнам", "том ям", "поке"),
  rule("mediterranean", "mediterranean", "greek", "средиземномор", "греческ"),
  rule("mexican", "mexican", "taco", "burrito", "мексикан", "тако", "буррито"),
  rule("middle eastern", "middle eastern", "hummus", "falafel", "ближневост", "хумус", "фалафел"),
];

const SPICY = patterns("spicy", "chili", "chilli", "jalapeno", "sriracha", "остр", "чили", "халапеньо", "шрирач");
const CREAMY = patterns("cream", "creamy", "mayonnaise", "mayo", "cheese sauce", "сливоч", "майонез", "сырный соус");
const VEGETARIAN = patterns("vegetarian", "vegan", "plant based", "вегетариан", "веган", "растительное");
const HEAVY = patterns("double", "loaded", "cheesy", "bacon", "butter", "cream", "майонез", "бекон", "сливоч", "сырный", "двойной");
const LIGHT = patterns("light", "fresh", "low calorie", "лёгк", "легк", "свеж", "диетическ");

export function normalizeDish(input: {
  name: string;
  description?: string | undefined;
  menuCategories?: string[] | undefined;
  weight?: string | undefined;
}): NormalizedDish {
  const text = normalizeText([input.name, input.description, ...(input.menuCategories ?? [])].filter(Boolean).join(" "));
  const categories = matchRules(text, CATEGORY_RULES);
  const proteins = matchRules(text, PROTEIN_RULES);
  const cookingMethods = matchRules(text, METHOD_RULES);
  const cuisines = matchRules(text, CUISINE_RULES);
  const fried = cookingMethods.includes("fried");
  const creamy = matchesAny(text, CREAMY);
  const spicy = matchesAny(text, SPICY);
  const hasAnimalProtein = proteins.some((protein) => !["tofu", "legumes"].includes(protein));
  const vegetarian = matchesAny(text, VEGETARIAN) || (!hasAnimalProtein && categories.includes("salad"));

  let heaviness = 0.45;
  if (categories.includes("salad")) heaviness -= 0.2;
  if (categories.includes("soup")) heaviness -= 0.12;
  if (categories.includes("poke") || categories.includes("bowl")) heaviness -= 0.08;
  if (cookingMethods.includes("grilled") || cookingMethods.includes("steamed") || cookingMethods.includes("boiled")) heaviness -= 0.1;
  if (fried) heaviness += 0.28;
  if (creamy) heaviness += 0.18;
  if (categories.includes("pizza") || categories.includes("sandwich") || categories.includes("pasta")) heaviness += 0.18;
  if (matchesAny(text, HEAVY)) heaviness += 0.12;
  if (matchesAny(text, LIGHT)) heaviness -= 0.12;
  heaviness += weightAdjustment(input.weight);

  return {
    categories: unique(categories),
    proteins: unique(proteins),
    cookingMethods: unique(cookingMethods),
    cuisines: unique(cuisines),
    spicy,
    fried,
    creamy,
    vegetarian,
    heaviness: round(clamp(heaviness)),
  };
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokenize(value: string): string[] {
  return unique(normalizeText(value).split(" ").filter((token) => token.length >= 3 && !STOP_WORDS.has(token)));
}

export function termMatchesDish(term: string, dish: NormalizedDish, text: string): boolean {
  const normalized = normalizeText(term);
  if (!normalized) return false;
  const canonical = canonicalValues(normalized);
  return (
    normalizeText(text).includes(normalized) ||
    canonical.some((value) =>
      dish.categories.includes(value) ||
      dish.proteins.includes(value) ||
      dish.cookingMethods.includes(value) ||
      dish.cuisines.includes(value),
    )
  );
}

export function canonicalValues(value: string): string[] {
  const text = normalizeText(value);
  return unique(
    [...CATEGORY_RULES, ...PROTEIN_RULES, ...METHOD_RULES, ...CUISINE_RULES]
      .filter((entry) => entry.patterns.some((pattern) => pattern.test(text)))
      .map((entry) => entry.value),
  );
}

function rule(value: string, ...values: string[]): Rule {
  return { value, patterns: patterns(...values) };
}

function patterns(...values: string[]): RegExp[] {
  return values.map((value) => new RegExp(escapeRegExp(normalizeText(value)), "iu"));
}

function matchRules(text: string, rules: Rule[]): string[] {
  return rules.filter((entry) => matchesAny(text, entry.patterns)).map((entry) => entry.value);
}

function matchesAny(text: string, values: RegExp[]): boolean {
  return values.some((value) => value.test(text));
}

function weightAdjustment(weight?: string): number {
  if (!weight) return 0;
  const normalized = weight.replace(",", ".");
  const amount = Number.parseFloat(normalized.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(amount)) return 0;
  const grams = /\bkg\b|кг/iu.test(normalized) ? amount * 1000 : amount;
  if (grams >= 600) return 0.18;
  if (grams >= 450) return 0.1;
  if (grams <= 200) return -0.08;
  return 0;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOP_WORDS = new Set([
  "and", "the", "with", "for", "from", "give", "want", "something", "please", "lunch", "dinner",
  "или", "для", "мне", "хочу", "дай", "что", "нибудь", "пожалуйста", "обед", "ужин", "блюдо",
]);
