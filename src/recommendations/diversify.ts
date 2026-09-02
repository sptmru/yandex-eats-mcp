import type { FoodResult } from "./types.js";

export function diversifyResults(
  candidates: FoodResult[],
  options: { limit: number; maxPerRestaurant: number; maxPerCategory: number; exploration: number },
): FoodResult[] {
  const remaining = [...candidates].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const selected: FoodResult[] = [];
  const restaurantCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  while (remaining.length > 0 && selected.length < options.limit) {
    let bestIndex = -1;
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (!candidate) continue;
      if ((restaurantCounts.get(candidate.placeSlug) ?? 0) >= options.maxPerRestaurant) continue;
      const primaryCategory = candidate.normalized.categories[0] ?? candidate.menuCategories[0] ?? "other";
      if ((categoryCounts.get(primaryCategory) ?? 0) >= options.maxPerCategory) continue;

      const similarity = selected.length === 0
        ? 0
        : Math.max(...selected.map((entry) => dishSimilarity(candidate, entry)));
      const categoryNovelty = 1 / (1 + (categoryCounts.get(primaryCategory) ?? 0));
      const restaurantNovelty = 1 / (1 + (restaurantCounts.get(candidate.placeSlug) ?? 0));
      const diversityWeight = 0.18 + options.exploration * 0.22;
      const utility = candidate.score * (1 - diversityWeight) +
        (categoryNovelty * 0.6 + restaurantNovelty * 0.4) * diversityWeight -
        similarity * (0.12 + options.exploration * 0.18);
      if (utility > bestUtility) {
        bestUtility = utility;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    if (!chosen) break;
    selected.push(chosen);
    restaurantCounts.set(chosen.placeSlug, (restaurantCounts.get(chosen.placeSlug) ?? 0) + 1);
    const category = chosen.normalized.categories[0] ?? chosen.menuCategories[0] ?? "other";
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }

  return selected;
}

function dishSimilarity(left: FoodResult, right: FoodResult): number {
  if (left.placeSlug === right.placeSlug && left.itemId === right.itemId) return 1;
  const leftFeatures = new Set([
    ...left.normalized.categories,
    ...left.normalized.proteins,
    ...left.normalized.cookingMethods,
    ...left.normalized.cuisines,
  ]);
  const rightFeatures = new Set([
    ...right.normalized.categories,
    ...right.normalized.proteins,
    ...right.normalized.cookingMethods,
    ...right.normalized.cuisines,
  ]);
  if (leftFeatures.size === 0 || rightFeatures.size === 0) return left.placeSlug === right.placeSlug ? 0.35 : 0;
  const overlap = [...leftFeatures].filter((value) => rightFeatures.has(value)).length;
  const union = new Set([...leftFeatures, ...rightFeatures]).size;
  return overlap / union + (left.placeSlug === right.placeSlug ? 0.2 : 0);
}
