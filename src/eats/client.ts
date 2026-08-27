import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { EatsError } from "../mcp/errors.js";
import { MutationLock } from "../security/mutation-lock.js";
import { ENDPOINTS } from "./endpoints.js";
import { mapCartResponse, mapCartSummaries } from "./mappers/cart.js";
import { mapMenuResponse } from "./mappers/menu.js";
import { mapPlaceResponse } from "./mappers/place.js";
import { mapSearchResponse } from "./mappers/search.js";
import type {
  CartSummary,
  NormalizedCart,
  NormalizedMenu,
  NormalizedMenuCategory,
  NormalizedPlace,
  NormalizedSearch,
} from "./schemas.js";
import { EatsSession } from "./session.js";

type FetchLike = typeof fetch;
type QueryValue = string | number | boolean | undefined | null;

export type SelectedOptionInput = {
  groupId: string;
  groupName: string;
  selected: Array<{ optionId: string; quantity: number }>;
};

export type AddItemInput = {
  itemId: string;
  quantity: number;
  options: SelectedOptionInput[];
};

export type CartMutationResult = {
  operationId: string;
  before: NormalizedCart;
  after: NormalizedCart;
};

export class YandexEatsClient {
  readonly session: EatsSession;
  private readonly mutationLock = new MutationLock();
  private readonly operations = new Map<
    string,
    { fingerprint: string; createdAt: number; result: Promise<CartMutationResult> }
  >();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly fetchImplementation: FetchLike = fetch,
  ) {
    this.session = new EatsSession(config, logger);
  }

  async initialize(): Promise<void> {
    await this.session.initialize();
  }

  async authStatus(): Promise<{
    authenticated: boolean;
    cookieLoaded: boolean;
    cookieExpiresAt: null;
    needsRefresh: boolean;
  }> {
    if (!this.session.isCookieLoaded()) {
      return { authenticated: false, cookieLoaded: false, cookieExpiresAt: null, needsRefresh: true };
    }
    try {
      await this.request("GET", ENDPOINTS.passportProfile, { authenticated: true });
      return { authenticated: true, cookieLoaded: true, cookieExpiresAt: null, needsRefresh: false };
    } catch (error) {
      if (error instanceof EatsError && error.code === "AUTH_EXPIRED") {
        return { authenticated: false, cookieLoaded: true, cookieExpiresAt: null, needsRefresh: true };
      }
      throw error;
    }
  }

  getDeliveryContext(): {
    configured: boolean;
    city?: string;
    label?: string;
    shippingType: "delivery";
  } {
    const configured = this.config.eats.latitude !== undefined && this.config.eats.longitude !== undefined;
    return {
      configured,
      ...(this.config.eats.city ? { city: this.config.eats.city } : {}),
      ...(this.config.eats.addressLabel ? { label: this.config.eats.addressLabel } : {}),
      shippingType: "delivery",
    };
  }

  async search(input: {
    query: string;
    maxPlaces?: number | undefined;
    maxItemsPerPlace?: number | undefined;
    cursor?: string | undefined;
    includeUnavailable?: boolean | undefined;
  }): Promise<NormalizedSearch> {
    const location = this.requireLocation();
    const raw = await this.request("POST", ENDPOINTS.search, {
      body: {
        text: input.query,
        location,
        ...(input.cursor ? { pagination: { context: input.cursor } } : {}),
      },
      readLike: true,
    });
    return mapSearchResponse(
      raw,
      input.query,
      input.maxPlaces ?? this.config.eats.maxSearchPlaces,
      input.maxItemsPerPlace ?? this.config.eats.maxItemsPerPlace,
      input.includeUnavailable ?? false,
    );
  }

  async getPlace(placeSlug: string): Promise<NormalizedPlace> {
    const location = this.requireLocation();
    const raw = await this.request("GET", ENDPOINTS.catalog(placeSlug), {
      query: { ...location, shippingType: "delivery" },
    });
    return mapPlaceResponse(raw);
  }

  async getMenu(input: {
    placeSlug: string;
    query?: string | undefined;
    categoryIds?: string[] | undefined;
    includeUnavailable?: boolean | undefined;
  }): Promise<NormalizedMenu> {
    const location = this.requireLocation();
    const raw = await this.request("GET", ENDPOINTS.menu(input.placeSlug), {
      query: { ...location, autoTranslate: false },
    });
    const menu = mapMenuResponse(raw, input.placeSlug);
    return filterMenu(menu, input);
  }

  async listCarts(): Promise<CartSummary[]> {
    const raw = await this.request("POST", ENDPOINTS.multiCarts, {
      authenticated: true,
      query: this.cartQuery("cart"),
      body: { need_items_icons: true },
      readLike: true,
    });
    return mapCartSummaries(raw);
  }

  async getCart(reference: { placeSlug?: string; groupSlug?: string }): Promise<NormalizedCart> {
    if (!reference.placeSlug && !reference.groupSlug) {
      throw new EatsError("VALIDATION_ERROR", "A placeSlug or groupSlug is required to load a full cart.");
    }
    const raw = await this.request("POST", ENDPOINTS.fullCarts, {
      authenticated: true,
      query: {
        ...this.cartQuery("cart"),
        placeSlug: reference.placeSlug,
        group_slug: reference.groupSlug,
      },
      body: {},
      readLike: true,
    });
    return mapCartResponse(raw);
  }

  async addItems(input: {
    placeSlug: string;
    placeBusiness: string;
    items: AddItemInput[];
    operationId: string;
  }): Promise<CartMutationResult> {
    this.requireMutations();
    return this.runIdempotentMutation(input.operationId, input, () => this.mutationLock.run(input.placeSlug, async () => {
      await this.validateAddItems(input.placeSlug, input.items);
      const before = await this.getCart({ placeSlug: input.placeSlug });
      try {
        if (input.items.length > 1 && input.items.every((item) => item.options.length === 0)) {
          await this.request("POST", ENDPOINTS.addCartItemsBulk, {
            authenticated: true,
            unsafeMutation: true,
            query: this.cartQuery("catalog"),
            body: {
              items: input.items.map((item) => ({ item_id: numericId(item.itemId), quantity: item.quantity })),
              place_slug: input.placeSlug,
              place_business: input.placeBusiness,
            },
          });
        } else {
          if (input.items.length !== 1) {
            throw new EatsError(
              "VALIDATION_ERROR",
              "Configured items must be added one at a time; only simple items support atomic bulk add.",
            );
          }
          const item = input.items[0];
          if (!item) throw new EatsError("VALIDATION_ERROR", "At least one item is required.");
          await this.request("POST", ENDPOINTS.addCartItem, {
            authenticated: true,
            unsafeMutation: true,
            query: this.cartQuery("catalog"),
            body: {
              quantity: item.quantity,
              place_slug: input.placeSlug,
              place_business: input.placeBusiness,
              item_id: numericId(item.itemId),
              item_options: item.options.map((group) => ({
                group_id: numericId(group.groupId),
                group_name: group.groupName,
                group_options: group.selected.map((option) => numericId(option.optionId)),
                modifiers: group.selected.map((option) => ({
                  option_id: numericId(option.optionId),
                  quantity: option.quantity,
                })),
              })),
            },
          });
        }
      } catch (error) {
        if (error instanceof EatsError && error.code === "MUTATION_STATUS_UNKNOWN") throw error;
        throw error;
      }
      const after = await this.getCart({ placeSlug: input.placeSlug });
      return { operationId: input.operationId, before, after };
    }));
  }

  async updateCartItem(input: {
    placeSlug: string;
    cartItemId: string;
    quantity: number;
    options: SelectedOptionInput[];
    operationId: string;
  }): Promise<CartMutationResult> {
    this.requireMutations();
    return this.runIdempotentMutation(input.operationId, input, () => this.mutationLock.run(input.placeSlug, async () => {
      const before = await this.getCart({ placeSlug: input.placeSlug });
      await this.request("PUT", ENDPOINTS.cartItem(input.cartItemId), {
        authenticated: true,
        unsafeMutation: true,
        query: this.cartQuery("cart"),
        body: {
          quantity: input.quantity,
          item_options: input.options.map((group) => ({
            group_id: numericId(group.groupId),
            group_name: group.groupName,
            group_options: group.selected.map((option) => numericId(option.optionId)),
            modifiers: group.selected.map((option) => ({
              option_id: numericId(option.optionId),
              quantity: option.quantity,
            })),
          })),
        },
      });
      const after = await this.getCart({ placeSlug: input.placeSlug });
      return { operationId: input.operationId, before, after };
    }));
  }

  async removeCartItem(input: {
    placeSlug: string;
    cartItemId: string;
    operationId: string;
  }): Promise<CartMutationResult> {
    this.requireMutations();
    return this.runIdempotentMutation(input.operationId, input, () => this.mutationLock.run(input.placeSlug, async () => {
      const before = await this.getCart({ placeSlug: input.placeSlug });
      await this.request("DELETE", ENDPOINTS.cartItem(input.cartItemId), {
        authenticated: true,
        unsafeMutation: true,
        query: this.cartQuery("cart"),
      });
      const after = await this.getCart({ placeSlug: input.placeSlug });
      return { operationId: input.operationId, before, after };
    }));
  }

  private requireLocation(): { longitude: number; latitude: number } {
    if (this.config.eats.latitude === undefined || this.config.eats.longitude === undefined) {
      throw new EatsError(
        "DELIVERY_LOCATION_NOT_CONFIGURED",
        "Delivery coordinates are not configured on the MCP server.",
      );
    }
    return { longitude: this.config.eats.longitude, latitude: this.config.eats.latitude };
  }

  private requireMutations(): void {
    if (!this.config.eats.mutationsEnabled) {
      throw new EatsError(
        "MUTATIONS_DISABLED",
        "Cart mutations are disabled. Set YANDEX_EATS_ENABLE_MUTATIONS=true after the opt-in live test is prepared.",
      );
    }
  }

  private async validateAddItems(placeSlug: string, requestedItems: AddItemInput[]): Promise<void> {
    const menu = await this.getMenu({ placeSlug, includeUnavailable: true });
    const menuItems = flattenMenuItems(menu.categories);
    for (const requested of requestedItems) {
      const menuItem = menuItems.find((item) => item.itemId === requested.itemId);
      if (!menuItem) {
        throw new EatsError("VALIDATION_ERROR", `Item ${requested.itemId} was not found in the current menu.`);
      }
      if (!menuItem.available) {
        throw new EatsError("PLACE_UNAVAILABLE", `${menuItem.name} is currently unavailable.`);
      }
      const selectedGroups = new Map(requested.options.map((group) => [group.groupId, group]));
      for (const group of menuItem.optionGroups) {
        const selected = selectedGroups.get(group.groupId);
        if (group.required && !selected) {
          throw new EatsError("REQUIRES_CONFIGURATION", `${menuItem.name} requires an option for ${group.name}.`, {
            details: {
              itemId: menuItem.itemId,
              groupId: group.groupId,
              groupName: group.name,
              minSelected: group.minSelected,
              maxSelected: group.maxSelected,
              options: group.options.map((option) => ({ optionId: option.optionId, name: option.name })),
            },
          });
        }
        if (!selected) continue;
        const selectedCount = selected.selected.reduce((sum, option) => sum + option.quantity, 0);
        if (selectedCount < group.minSelected || selectedCount > group.maxSelected) {
          throw new EatsError(
            "VALIDATION_ERROR",
            `${group.name} requires between ${group.minSelected} and ${group.maxSelected} selections.`,
          );
        }
        const validOptionIds = new Set(group.options.map((option) => option.optionId));
        if (selected.selected.some((option) => !validOptionIds.has(option.optionId))) {
          throw new EatsError("VALIDATION_ERROR", `An invalid option was provided for ${group.name}.`);
        }
      }
      const validGroupIds = new Set(menuItem.optionGroups.map((group) => group.groupId));
      if (requested.options.some((group) => !validGroupIds.has(group.groupId))) {
        throw new EatsError("VALIDATION_ERROR", `An invalid option group was provided for ${menuItem.name}.`);
      }
    }
  }

  private runIdempotentMutation(
    operationId: string,
    input: Record<string, unknown>,
    operation: () => Promise<CartMutationResult>,
  ): Promise<CartMutationResult> {
    const now = Date.now();
    for (const [key, entry] of this.operations) {
      if (now - entry.createdAt > 10 * 60 * 1_000) this.operations.delete(key);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = this.operations.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new EatsError("VALIDATION_ERROR", "operationId was already used for a different cart mutation."),
        );
      }
      return existing.result;
    }
    const result = operation();
    this.operations.set(operationId, { fingerprint, createdAt: now, result });
    return result;
  }

  private cartQuery(screen: "catalog" | "cart"): Record<string, QueryValue> {
    const location = this.requireLocation();
    return {
      ...location,
      screen,
      shippingType: "delivery",
      autoTranslate: false,
      plus_subscription_toggle_state: false,
      combo_subscription_toggle_state: false,
    };
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: {
      query?: Record<string, QueryValue>;
      body?: unknown;
      authenticated?: boolean;
      readLike?: boolean;
      unsafeMutation?: boolean;
    } = {},
  ): Promise<unknown> {
    if (!path.startsWith("/")) throw new Error("Upstream path must be absolute");
    if (options.authenticated && !this.session.isCookieLoaded()) {
      throw new EatsError("AUTH_NOT_CONFIGURED", "Yandex Eats cookie secret is not configured.");
    }
    const url = new URL(path, this.config.eats.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const maxAttempts = method === "GET" || options.readLike ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Accept-Language": this.config.eats.locale,
        "X-Platform": this.config.eats.platform,
        "X-App-Version": this.config.eats.appVersion,
        "X-Device-Id": this.session.deviceId,
        "X-Client-Session": this.session.clientSession,
        "X-Taxi": `yandex-eats-mcp/0.1 platform=eats_desktop_web`,
        Origin: this.config.eats.baseUrl.origin,
        Referer: `${this.config.eats.baseUrl.origin}/`,
        ...(await this.session.buildSensitiveHeaders()),
      };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const startedAt = performance.now();
      try {
        const response = await this.fetchImplementation(url, {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(this.config.eats.timeoutMs),
        });
        await this.session.absorbResponse(response.headers);
        const requestId = response.headers.get("x-yarequestid") ?? response.headers.get("x-yatraceid");
        this.logger.info(
          {
            method,
            upstreamPath: path,
            status: response.status,
            durationMs: Math.round(performance.now() - startedAt),
            requestId,
          },
          "Yandex Eats request completed",
        );

        if (response.status === 401 || response.status === 403) {
          throw new EatsError("AUTH_EXPIRED", "Yandex Eats authentication expired; refresh the cookie secret.");
        }
        if (response.status === 429) {
          const error = new EatsError("UPSTREAM_RATE_LIMITED", "Yandex Eats rate-limited the request.", {
            retryable: true,
            ...(requestId ? { details: { requestId } } : {}),
          });
          if (attempt < maxAttempts) continue;
          throw error;
        }
        if (response.status >= 500) {
          if (options.unsafeMutation) {
            throw new EatsError(
              "MUTATION_STATUS_UNKNOWN",
              "Yandex Eats failed during a cart mutation. The MCP did not retry; load the cart to reconcile state.",
              requestId ? { details: { requestId } } : {},
            );
          }
          if (attempt < maxAttempts) continue;
          throw new EatsError("UPSTREAM_UNAVAILABLE", "Yandex Eats is temporarily unavailable.", {
            retryable: true,
            ...(requestId ? { details: { requestId } } : {}),
          });
        }
        if (!response.ok) {
          const errorCode = response.headers.get("x-error-code");
          throw new EatsError("UPSTREAM_BAD_RESPONSE", `Yandex Eats rejected the request (${response.status}).`, {
            details: {
              status: response.status,
              ...(errorCode ? { upstreamCode: errorCode } : {}),
              ...(requestId ? { requestId } : {}),
            },
          });
        }
        if (response.status === 204) return null;
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("json")) {
          throw new EatsError("UPSTREAM_BAD_RESPONSE", "Yandex Eats returned a non-JSON response.");
        }
        return await response.json();
      } catch (error) {
        if (error instanceof EatsError) throw error;
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        if (options.unsafeMutation) {
          throw new EatsError(
            "MUTATION_STATUS_UNKNOWN",
            "The cart mutation timed out or lost its response. The MCP did not retry; load the cart to reconcile state.",
            { cause: error },
          );
        }
        if (attempt < maxAttempts) continue;
        throw new EatsError(
          timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
          timedOut ? "Yandex Eats timed out." : "Yandex Eats could not be reached.",
          { retryable: true, cause: error },
        );
      }
    }
    throw new EatsError("UPSTREAM_UNAVAILABLE", "Yandex Eats request attempts were exhausted.");
  }
}

function filterMenu(
  menu: NormalizedMenu,
  input: {
    query?: string | undefined;
    categoryIds?: string[] | undefined;
    includeUnavailable?: boolean | undefined;
  },
): NormalizedMenu {
  const query = input.query?.trim().toLocaleLowerCase();
  const ids = input.categoryIds ? new Set(input.categoryIds.map(String)) : undefined;
  const filterCategory = (category: NormalizedMenuCategory): NormalizedMenuCategory | undefined => {
    if (ids && !ids.has(category.categoryId)) {
      const children = category.categories
        .map(filterCategory)
        .filter((value): value is NormalizedMenuCategory => value !== undefined);
      return children.length > 0 ? { ...category, items: [], categories: children } : undefined;
    }
    const items = category.items.filter((item) => {
      if (!input.includeUnavailable && !item.available) return false;
      if (!query) return true;
      return `${item.name} ${item.description ?? ""}`.toLocaleLowerCase().includes(query);
    });
    const categories = category.categories
      .map(filterCategory)
      .filter((value): value is NormalizedMenuCategory => value !== undefined);
    if ((query || ids) && items.length === 0 && categories.length === 0) return undefined;
    return { ...category, items, categories };
  };
  return {
    ...menu,
    categories: menu.categories
      .map(filterCategory)
      .filter((value): value is NormalizedMenuCategory => value !== undefined),
  };
}

function numericId(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value;
}

function flattenMenuItems(categories: NormalizedMenuCategory[]): NormalizedMenu["categories"][number]["items"] {
  return categories.flatMap((category) => [
    ...category.items,
    ...flattenMenuItems(category.categories),
  ]);
}
