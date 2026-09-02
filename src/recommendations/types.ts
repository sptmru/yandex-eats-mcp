import { z } from "zod";

export const normalizedDishSchema = z.object({
  categories: z.array(z.string()),
  proteins: z.array(z.string()),
  cookingMethods: z.array(z.string()),
  cuisines: z.array(z.string()),
  spicy: z.boolean(),
  fried: z.boolean(),
  creamy: z.boolean(),
  vegetarian: z.boolean(),
  heaviness: z.number().min(0).max(1),
});

export const intentMatchSchema = z.object({
  intent: z.string(),
  requiredTerms: z.array(z.string()),
  modifierTerms: z.array(z.string()),
  matchedTerms: z.array(z.string()),
  intentCoverage: z.number().min(0).max(1),
  matchedIntent: z.boolean(),
});

export const recommendationIntentGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  alternatives: z.array(z.array(z.string())),
});

export const foodResultSchema = z.object({
  placeSlug: z.string(),
  placeName: z.string(),
  placeBusiness: z.string(),
  eta: z.string().optional(),
  rating: z.number().optional(),
  priceCategory: z.string().optional(),
  promos: z.array(z.string()),
  itemId: z.string(),
  publicId: z.string().optional(),
  name: z.string(),
  searchName: z.string().optional(),
  description: z.string().optional(),
  price: z.number().nonnegative(),
  currency: z.string(),
  weight: z.string().optional(),
  adult: z.boolean(),
  hasRequiredOptions: z.boolean(),
  menuCategories: z.array(z.string()),
  normalized: normalizedDishSchema,
  matchedTerms: z.array(z.string()),
  intentCoverage: z.number().min(0).max(1),
  matchedIntent: z.boolean(),
  intentMatches: z.array(intentMatchSchema),
  matchedIntents: z.array(z.string()),
  score: z.number().min(0).max(1),
  scoreReasons: z.array(z.string()),
});

export const foodSearchResultSchema = z.object({
  queries: z.array(z.string()),
  candidatePlaces: z.number().int().nonnegative(),
  menusLoaded: z.number().int().nonnegative(),
  results: z.array(foodResultSchema),
  warnings: z.array(z.string()),
});

export const recommendationResultSchema = z.object({
  query: z.string(),
  searchIntents: z.array(z.string()),
  intentGroups: z.array(recommendationIntentGroupSchema),
  sameRestaurant: z.boolean(),
  restaurantCoverage: z.object({
    placeSlug: z.string(),
    placeName: z.string(),
    matchedGroups: z.number().int().nonnegative(),
    totalGroups: z.number().int().positive(),
    coverage: z.number().min(0).max(1),
  }).optional(),
  candidatePlaces: z.number().int().nonnegative(),
  menusLoaded: z.number().int().nonnegative(),
  results: z.array(foodResultSchema),
  warnings: z.array(z.string()),
});

export const foodPreferenceSchema = z.object({
  placeSlug: z.string(),
  placeName: z.string().optional(),
  itemId: z.string().optional(),
  itemName: z.string().optional(),
  liked: z.boolean().optional(),
  rating: z.number().int().min(1).max(5).optional(),
  orderCount: z.number().int().nonnegative(),
  lastOrderedAt: z.string().optional(),
  updatedAt: z.string(),
});

export const foodPreferencesResultSchema = z.object({
  preferences: z.array(foodPreferenceSchema),
});

export type NormalizedDish = z.infer<typeof normalizedDishSchema>;
export type IntentMatch = z.infer<typeof intentMatchSchema>;
export type RecommendationIntentGroup = z.infer<typeof recommendationIntentGroupSchema>;
export type FoodResult = z.infer<typeof foodResultSchema>;
export type FoodSearchResult = z.infer<typeof foodSearchResultSchema>;
export type RecommendationResult = z.infer<typeof recommendationResultSchema>;
export type FoodPreference = z.infer<typeof foodPreferenceSchema>;

export type DishCandidate = Omit<FoodResult, "score" | "scoreReasons"> & {
  relevance: number;
};

export type RecommendFoodInput = {
  query: string;
  categories?: string[] | undefined;
  prefer?: string[] | undefined;
  avoid?: string[] | undefined;
  maxPrice?: number | undefined;
  maxHeaviness?: number | undefined;
  maxPerRestaurant?: number | undefined;
  maxPerCategory?: number | undefined;
  exploration?: number | undefined;
  sameRestaurant?: boolean | undefined;
  limit?: number | undefined;
};

export type SearchItemsInput = {
  queries: string[];
  maxPlaces?: number | undefined;
  maxItems?: number | undefined;
  maxPagesPerQuery?: number | undefined;
  deduplicate?: boolean | undefined;
};
