import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { YandexEatsClient } from "../eats/client.js";
import {
  cartSummarySchema,
  normalizedCartSchema,
  normalizedMenuSchema,
  normalizedPlaceSchema,
  normalizedSearchSchema,
} from "../eats/schemas.js";
import { toPublicError } from "./errors.js";
import { createInactiveOrderMonitorService, type OrderMonitorService } from "../orders/order-monitor.js";
import { normalizedOrderStatusSchema, orderEventSchema } from "../orders/types.js";

const errorSchema = {
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
};

const optionInputSchema = z.object({
  groupId: z.union([z.string(), z.number()]).transform(String),
  groupName: z.string().min(1).max(200),
  selected: z
    .array(
      z.object({
        optionId: z.union([z.string(), z.number()]).transform(String),
        quantity: z.number().int().min(1).max(20).default(1),
      }),
    )
    .min(1),
});

export function createYandexEatsMcpServer(
  client: YandexEatsClient,
  config: AppConfig,
  logger: Logger,
  orderMonitor: OrderMonitorService = createInactiveOrderMonitorService(config),
): McpServer {
  const server = new McpServer(
    { name: "yandex-eats-mcp", version: "0.1.0" },
    {
      instructions:
        "Search, order monitoring, and other read tools may run automatically. To consume order changes, call get_order_events with the last nextSequence cursor; the MCP cannot initiate a message in a sleeping ChatGPT conversation. Cart mutations require the user's explicit request. Before add_to_cart, inspect get_menu and never guess required options. Never remove or replace items as an optimization. Items marked adult may be added to the cart; any eligibility or age-verification requirements remain enforced by Yandex Eats. Pickup, SKU carts, checkout, and place_order are unsupported. A mutation result contains a fresh server cart snapshot; after an ambiguous mutation error, call get_cart to reconcile.",
    },
  );

  server.registerTool(
    "auth_status",
    {
      title: "Check Yandex Eats authentication",
      description:
        "Check whether the server-side Yandex Eats cookie session is usable. Returns no account profile, cookie, token, phone, or address data.",
      inputSchema: {},
      outputSchema: {
        authenticated: z.boolean(),
        cookieLoaded: z.boolean(),
        cookieExpiresAt: z.null(),
        needsRefresh: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => toolCall(logger, "auth_status", () => client.authStatus(), (value) =>
      value.authenticated ? "Yandex Eats authentication is active." : "Yandex Eats authentication needs attention.",
    ),
  );

  server.registerTool(
    "get_delivery_context",
    {
      title: "Get delivery context",
      description:
        "Return only the safe server-configured city and address label. Exact coordinates and the full address are intentionally not exposed.",
      inputSchema: {},
      outputSchema: {
        configured: z.boolean(),
        city: z.string().optional(),
        label: z.string().optional(),
        shippingType: z.literal("delivery"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    () => toolCall(logger, "get_delivery_context", () => Promise.resolve(client.getDeliveryContext()), (value) =>
      value.configured ? "A delivery location is configured." : "Delivery coordinates are not configured.",
    ),
  );

  server.registerTool(
    "search",
    {
      title: "Search Yandex Eats",
      description:
        "Search available restaurants and matching menu items near the configured delivery location. Use the opaque cursor unchanged to fetch another page.",
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        maxPlaces: z.number().int().min(1).max(50).optional(),
        maxItemsPerPlace: z.number().int().min(1).max(25).optional(),
        cursor: z.string().min(1).max(10_000).optional(),
        includeUnavailable: z.boolean().default(false),
      },
      outputSchema: normalizedSearchSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (input) => toolCall(logger, "search", () => client.search(compactOptional(input)), (value) =>
      `Found ${value.places.length} matching places.`,
    ),
  );

  server.registerTool(
    "get_place",
    {
      title: "Get restaurant availability",
      description: "Get current availability, delivery timing, rating, and supported shipping types for one place.",
      inputSchema: { placeSlug: z.string().trim().min(1).max(300) },
      outputSchema: normalizedPlaceSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ placeSlug }) => toolCall(logger, "get_place", () => client.getPlace(placeSlug), (value) =>
      `${value.name} is ${value.available ? "available" : "unavailable"}.`,
    ),
  );

  server.registerTool(
    "get_menu",
    {
      title: "Get restaurant menu",
      description:
        "Load and optionally filter a place menu. Inspect optionGroups before adding an item; required options must never be guessed.",
      inputSchema: {
        placeSlug: z.string().trim().min(1).max(300),
        query: z.string().trim().min(1).max(200).optional(),
        categoryIds: z.array(z.union([z.string(), z.number()]).transform(String)).max(50).optional(),
        includeUnavailable: z.boolean().default(false),
      },
      outputSchema: normalizedMenuSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (input) => toolCall(logger, "get_menu", () => client.getMenu(compactOptional(input)), (value) =>
      `Loaded ${countMenuItems(value.categories)} menu items.`,
    ),
  );

  server.registerTool(
    "get_cart",
    {
      title: "Get Yandex Eats cart",
      description:
        "List all carts when no reference is given, or return the fresh server cart for a placeSlug/groupSlug. Totals and constraints come from Yandex Eats.",
      inputSchema: {
        placeSlug: z.string().trim().min(1).max(300).optional(),
        groupSlug: z.string().trim().min(1).max(300).optional(),
      },
      outputSchema: {
        mode: z.enum(["list", "full"]),
        carts: z.array(cartSummarySchema).optional(),
        cart: normalizedCartSchema.optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ placeSlug, groupSlug }) =>
      toolCall(
        logger,
        "get_cart",
        async () => {
          if (!placeSlug && !groupSlug) return { mode: "list" as const, carts: await client.listCarts() };
          return {
            mode: "full" as const,
            cart: await client.getCart({
              ...(placeSlug ? { placeSlug } : {}),
              ...(groupSlug ? { groupSlug } : {}),
            }),
          };
        },
        (value) =>
          value.mode === "list"
            ? `Found ${value.carts.length} carts.`
            : `Loaded a cart with ${value.cart.items.length} items.`,
      ),
  );

  server.registerTool(
    "get_active_orders",
    {
      title: "Get active Yandex Eats orders",
      description: "Return sanitized cached active-order statuses and order-monitor health. No address, coordinates, phone, payment, map, or courier identity is exposed.",
      inputSchema: {},
      outputSchema: {
        monitorEnabled: z.boolean(),
        monitorHealthy: z.boolean(),
        authExpired: z.boolean(),
        lastSuccessfulPollAt: z.string().optional(),
        orders: z.array(normalizedOrderStatusSchema),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    () => toolCall(logger, "get_active_orders", () => Promise.resolve(orderMonitor.getHealth()), (value) =>
      `Order monitor returned ${value.orders.length} active orders.`,
    ),
  );

  server.registerTool(
    "get_order_status",
    {
      title: "Get one Yandex Eats order status",
      description: "Return a sanitized cached status for one order. Set refresh=true to perform an immediate read-only tracking request.",
      inputSchema: {
        orderNr: z.union([z.string(), z.number()]).transform(String),
        refresh: z.boolean().default(false),
      },
      outputSchema: {
        found: z.boolean(),
        status: normalizedOrderStatusSchema.optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    ({ orderNr, refresh }) => toolCall(
      logger,
      "get_order_status",
      async () => {
        const status = await orderMonitor.getOrderStatus(orderNr, refresh);
        return { found: status !== undefined, ...(status ? { status } : {}) };
      },
      (value) => value.found ? "Order status loaded." : "Order status is not cached.",
    ),
  );

  server.registerTool(
    "get_order_events",
    {
      title: "Get Yandex Eats order events",
      description: "Read order changes from the persistent journal using an exclusive sequence cursor. Readers do not acknowledge or consume events for other clients.",
      inputSchema: {
        afterSequence: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        orderNr: z.union([z.string(), z.number()]).transform(String).optional(),
      },
      outputSchema: {
        events: z.array(orderEventSchema),
        nextSequence: z.number().int().nonnegative(),
        hasMore: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (input) => toolCall(
      logger,
      "get_order_events",
      () => Promise.resolve(orderMonitor.getEvents(compactOptional(input))),
      (value) => `Loaded ${value.events.length} order events; next sequence is ${value.nextSequence}.`,
    ),
  );

  server.registerTool(
    "add_to_cart",
    {
      title: "Add items to Yandex Eats cart",
      description:
        "Add explicitly requested restaurant items, including items marked adult. Call get_menu first and pass every required option. Yandex Eats remains responsible for eligibility and age verification. Multiple items are allowed only when all have no options.",
      inputSchema: {
        placeSlug: z.string().trim().min(1).max(300),
        placeBusiness: z.literal("restaurant"),
        operationId: z.string().uuid().optional(),
        items: z
          .array(
            z.object({
              itemId: z.union([z.string(), z.number()]).transform(String),
              quantity: z.number().int().min(1).max(20),
              options: z.array(optionInputSchema).default([]),
            }),
          )
          .min(1)
          .max(20),
      },
      outputSchema: {
        operationId: z.string(),
        before: normalizedCartSchema,
        after: normalizedCartSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) =>
      toolCall(
        logger,
        "add_to_cart",
        () => client.addItems({ ...input, operationId: input.operationId ?? randomUUID() }),
        (value) => describeMutation("Added items", value.before.items.length, value.after.items.length, value.after.total),
      ),
  );

  server.registerTool(
    "update_cart_item",
    {
      title: "Update a cart item",
      description:
        "Set the quantity and exact options for one existing cart item after an explicit user request. Returns before and fresh after snapshots.",
      inputSchema: {
        placeSlug: z.string().trim().min(1).max(300),
        cartItemId: z.union([z.string(), z.number()]).transform(String),
        quantity: z.number().int().min(1).max(20),
        options: z.array(optionInputSchema).default([]),
        operationId: z.string().uuid().optional(),
      },
      outputSchema: {
        operationId: z.string(),
        before: normalizedCartSchema,
        after: normalizedCartSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) =>
      toolCall(
        logger,
        "update_cart_item",
        () => client.updateCartItem({ ...input, operationId: input.operationId ?? randomUUID() }),
        (value) => describeMutation("Updated item", value.before.items.length, value.after.items.length, value.after.total),
      ),
  );

  server.registerTool(
    "remove_cart_item",
    {
      title: "Remove a cart item",
      description:
        "Remove exactly one cart item only when the user explicitly asks to remove it. Never call this as an automatic budget optimization.",
      inputSchema: {
        placeSlug: z.string().trim().min(1).max(300),
        cartItemId: z.union([z.string(), z.number()]).transform(String),
        operationId: z.string().uuid().optional(),
      },
      outputSchema: {
        operationId: z.string(),
        before: normalizedCartSchema,
        after: normalizedCartSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input) =>
      toolCall(
        logger,
        "remove_cart_item",
        () => client.removeCartItem({ ...input, operationId: input.operationId ?? randomUUID() }),
        (value) => describeMutation("Removed item", value.before.items.length, value.after.items.length, value.after.total),
      ),
  );

  server.registerTool(
    "server_capabilities",
    {
      title: "Get Yandex Eats MCP capabilities",
      description: "Report enabled safety boundaries without revealing secrets or deployment details.",
      inputSchema: {},
      outputSchema: {
        cartMutationsEnabled: z.boolean(),
        checkoutEnabled: z.literal(false),
        placeOrderEnabled: z.literal(false),
        supportedShippingTypes: z.array(z.literal("delivery")),
        supportedBusinesses: z.array(z.literal("restaurant")),
        adultItemsSupported: z.literal(true),
        orderMonitoringEnabled: z.boolean(),
        orderEventJournalEnabled: z.literal(true),
        orderNotifier: z.enum(["none", "telegram"]),
        chatgptDirectPushSupported: z.literal(false),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    () =>
      toolCall(
        logger,
        "server_capabilities",
        () => Promise.resolve({
          cartMutationsEnabled: config.eats.mutationsEnabled,
          checkoutEnabled: false as const,
          placeOrderEnabled: false as const,
          supportedShippingTypes: ["delivery" as const],
          supportedBusinesses: ["restaurant" as const],
          adultItemsSupported: true as const,
          orderMonitoringEnabled: config.orders.enabled,
          orderEventJournalEnabled: true as const,
          orderNotifier: orderMonitor.getNotifierProvider(),
          chatgptDirectPushSupported: false as const,
        }),
        (value) => `Cart mutations are ${value.cartMutationsEnabled ? "enabled" : "disabled"}; checkout is disabled.`,
      ),
  );

  return server;
}

async function toolCall<T extends Record<string, unknown>>(
  logger: Logger,
  tool: string,
  operation: () => Promise<T>,
  summarize: (value: T) => string,
) {
  try {
    const structuredContent = await operation();
    return {
      content: [{ type: "text" as const, text: summarize(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    const publicError = toPublicError(error);
    logger.warn({ tool, errorCode: publicError.code }, "MCP tool failed");
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: publicError }) }],
    };
  }
}

function countMenuItems(categories: Array<{ items: unknown[]; categories: unknown[] }>): number {
  return categories.reduce(
    (total, category) =>
      total + category.items.length + countMenuItems(category.categories as Array<{ items: unknown[]; categories: unknown[] }>),
    0,
  );
}

function describeMutation(action: string, beforeCount: number, afterCount: number, total?: number): string {
  return `${action}. Cart items: ${beforeCount} -> ${afterCount}.${total === undefined ? "" : ` Server total: ${total}.`}`;
}

export const mcpErrorOutputSchema = errorSchema;

function compactOptional<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
