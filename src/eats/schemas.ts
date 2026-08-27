import { z } from "zod";

export const normalizedSearchItemSchema = z.object({
  itemId: z.string(),
  publicId: z.string().optional(),
  name: z.string(),
  price: z.number().nonnegative(),
  currency: z.string(),
  weight: z.string().optional(),
  adult: z.boolean(),
  hasRequiredOptions: z.boolean(),
});

export const normalizedSearchPlaceSchema = z.object({
  placeSlug: z.string(),
  name: z.string(),
  business: z.string(),
  available: z.boolean(),
  eta: z.string().optional(),
  rating: z.string().optional(),
  priceCategory: z.string().optional(),
  promos: z.array(z.string()),
  items: z.array(normalizedSearchItemSchema),
});

export const normalizedSearchSchema = z.object({
  query: z.string(),
  currency: z.string(),
  cursor: z.string().optional(),
  places: z.array(normalizedSearchPlaceSchema),
});

export const normalizedPlaceSchema = z.object({
  placeSlug: z.string(),
  name: z.string(),
  business: z.string(),
  rating: z.number().optional(),
  currency: z.string().optional(),
  available: z.boolean(),
  availableNow: z.boolean(),
  availableFrom: z.string().nullable().optional(),
  availableTo: z.string().nullable().optional(),
  deliveryTimeMin: z.number().optional(),
  deliveryTimeMax: z.number().optional(),
  shippingTypes: z.array(z.string()),
});

export const normalizedMenuOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  price: z.number(),
  multiplier: z.number(),
});

export const normalizedMenuOptionGroupSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  required: z.boolean(),
  minSelected: z.number().int().nonnegative(),
  maxSelected: z.number().int().nonnegative(),
  options: z.array(normalizedMenuOptionSchema),
});

export const normalizedMenuItemSchema = z.object({
  itemId: z.string(),
  publicId: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  price: z.number().nonnegative(),
  currency: z.string(),
  weight: z.string().optional(),
  available: z.boolean(),
  inStock: z.number().nullable().optional(),
  adult: z.boolean(),
  shippingType: z.string().optional(),
  optionGroups: z.array(normalizedMenuOptionGroupSchema),
});

export const normalizedMenuCategorySchema: z.ZodType<NormalizedMenuCategory> = z.lazy(() =>
  z.object({
    categoryId: z.string(),
    name: z.string(),
    available: z.boolean(),
    items: z.array(normalizedMenuItemSchema),
    categories: z.array(normalizedMenuCategorySchema),
  }),
);

export type NormalizedMenuCategory = {
  categoryId: string;
  name: string;
  available: boolean;
  items: z.infer<typeof normalizedMenuItemSchema>[];
  categories: NormalizedMenuCategory[];
};

export const normalizedMenuSchema = z.object({
  placeSlug: z.string(),
  currency: z.string(),
  categories: z.array(normalizedMenuCategorySchema),
});

export const normalizedCartItemSchema = z.object({
  cartItemId: z.string(),
  itemId: z.string().optional(),
  name: z.string(),
  quantity: z.number().nonnegative(),
  unitPrice: z.number().nonnegative().optional(),
  totalPrice: z.number().nonnegative().optional(),
  adult: z.boolean(),
  options: z.array(z.string()),
});

export const normalizedCartSchema = z.object({
  placeSlug: z.string().optional(),
  groupSlug: z.string().optional(),
  shippingType: z.string().optional(),
  currency: z.string().optional(),
  items: z.array(normalizedCartItemSchema),
  subtotal: z.number().optional(),
  discount: z.number().optional(),
  deliveryFee: z.number().optional(),
  total: z.number().optional(),
  violatedConstraints: z.array(z.string()),
  updatedAt: z.string().optional(),
});

export const cartSummarySchema = z.object({
  placeSlug: z.string().optional(),
  groupSlug: z.string().optional(),
  name: z.string().optional(),
  itemCount: z.number().int().nonnegative(),
  total: z.number().optional(),
  currency: z.string().optional(),
});

export type NormalizedSearch = z.infer<typeof normalizedSearchSchema>;
export type NormalizedPlace = z.infer<typeof normalizedPlaceSchema>;
export type NormalizedMenu = z.infer<typeof normalizedMenuSchema>;
export type NormalizedMenuItem = z.infer<typeof normalizedMenuItemSchema>;
export type NormalizedCart = z.infer<typeof normalizedCartSchema>;
export type CartSummary = z.infer<typeof cartSummarySchema>;

