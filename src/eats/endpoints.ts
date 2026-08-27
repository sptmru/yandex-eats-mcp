export const ENDPOINTS = {
  passportProfile: "/web-api/passport/profile",
  search: "/eats/v1/full-text-search/v1/search",
  catalog: (placeSlug: string) => `/api/v2/catalog/${encodeURIComponent(placeSlug)}`,
  menu: (placeSlug: string) => `/api/v2/menu/retrieve/${encodeURIComponent(placeSlug)}`,
  multiCarts: "/eats/v1/cart/v2/multi-carts",
  fullCarts: "/eats/v1/cart/v2/full-carts",
  addCartItem: "/api/v1/cart",
  addCartItemsBulk: "/api/v1/cart/add_bulk",
  cartItem: (cartItemId: string) => `/api/v1/cart/${encodeURIComponent(cartItemId)}`,
} as const;

