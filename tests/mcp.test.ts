import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { YandexEatsClient } from "../src/eats/client.js";
import { createLogger } from "../src/logger.js";
import { createYandexEatsMcpServer } from "../src/mcp/server.js";
import { FoodPreferenceStore } from "../src/recommendations/preferences-store.js";
import { RecommendationService } from "../src/recommendations/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP contract", () => {
  it("preserves omitted options in quantity-only cart updates", async () => {
    const context = await createTestConnection();
    const update = vi.spyOn(context.eatsClient, "updateCartItem").mockResolvedValue({
      operationId: "73b929ee-d660-4e50-8a8c-c1f0788a1b53",
      before: { items: [], violatedConstraints: [] },
      after: { items: [], violatedConstraints: [] },
    });
    try {
      const result = await context.mcpClient.callTool({ name: "update_cart_item", arguments: {
        placeSlug: "test-cafe", cartItemId: "cart-item-1", quantity: 2,
        operationId: "73b929ee-d660-4e50-8a8c-c1f0788a1b53",
      } });
      expect(result.isError).not.toBe(true);
      expect(update).toHaveBeenCalledWith({
        placeSlug: "test-cafe", cartItemId: "cart-item-1", quantity: 2,
        operationId: "73b929ee-d660-4e50-8a8c-c1f0788a1b53",
      });
    } finally {
      await context.close();
    }
  });

  it.each(["recommend_food", "search_items"])("forwards MCP cancellation to %s", async (tool) => {
    const context = await createTestConnection();
    const controller = new AbortController();
    let markStarted!: () => void;
    let markCancelled!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const cancelled = new Promise<void>((resolve) => { markCancelled = resolve; });
    const operation = (_input: unknown, signal?: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
      if (!signal) {
        markStarted();
        reject(new Error("MCP cancellation signal missing"));
        return;
      }
      signal.addEventListener("abort", () => {
        markCancelled();
        reject(new Error("Recommendation cancelled"));
      }, { once: true });
      markStarted();
    });
    vi.spyOn(context.recommendations, "recommend").mockImplementation(operation);
    vi.spyOn(context.recommendations, "searchItems").mockImplementation(operation);
    try {
      const pending = context.mcpClient.callTool({
        name: tool,
        arguments: tool === "recommend_food" ? { query: "salad" } : { queries: ["salad"] },
      }, undefined, { signal: controller.signal });
      const rejected = expect(pending).rejects.toBeDefined();
      await started;
      controller.abort();
      await rejected;
      await cancelled;
    } finally {
      await context.close();
    }
  });

  it("advertises focused tools with safety annotations and structured capabilities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-eats-mcp-tools-"));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      NODE_ENV: "test",
      MCP_AUTH_MODE: "none",
      MCP_STATE_DIR: directory,
      YANDEX_EATS_COOKIE_FILE: join(directory, "missing-cookie"),
    });
    const logger = createLogger("silent");
    const eatsClient = new YandexEatsClient(config, logger, () =>
      Promise.reject(new Error("No upstream requests expected")),
    );
    await eatsClient.initialize();
    const server = createYandexEatsMcpServer(eatsClient, config, logger);
    const mcpClient = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      const listed = await mcpClient.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "auth_status",
        "get_delivery_context",
        "search",
        "get_place",
        "search_items",
        "recommend_food",
        "record_food_feedback",
        "get_food_preferences",
        "get_menu",
        "get_cart",
        "get_active_orders",
        "get_order_status",
        "get_order_events",
        "add_to_cart",
        "update_cart_item",
        "remove_cart_item",
        "server_capabilities",
      ]);
      const remove = listed.tools.find((tool) => tool.name === "remove_cart_item");
      expect(remove?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
      const search = listed.tools.find((tool) => tool.name === "search");
      expect(search?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });

      const capabilities = await mcpClient.callTool({ name: "server_capabilities", arguments: {} });
      expect(capabilities.structuredContent).toMatchObject({
        cartMutationsEnabled: false,
        checkoutEnabled: false,
        placeOrderEnabled: false,
        adultItemsSupported: true,
        orderMonitoringEnabled: false,
        orderEventJournalEnabled: true,
        orderNotifier: "none",
        chatgptDirectPushSupported: false,
        foodRecommendationsSupported: true,
        foodPreferencesSupported: true,
      });
      const activeOrders = await mcpClient.callTool({ name: "get_active_orders", arguments: {} });
      expect(activeOrders.isError).not.toBe(true);
      expect(activeOrders.structuredContent).toMatchObject({
        monitorEnabled: false, monitorHealthy: true, listHealthy: false, trackingHealthy: true,
      });
      const events = listed.tools.find((tool) => tool.name === "get_order_events");
      expect(events?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
      const recommendations = listed.tools.find((tool) => tool.name === "recommend_food");
      expect(recommendations?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
      expect(Object.keys(recommendations?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining([
        "categories",
        "cuisines",
        "proteins",
        "cookingMethods",
        "anyOf",
      ]));
      const feedback = listed.tools.find((tool) => tool.name === "record_food_feedback");
      expect(feedback?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });

      const recorded = await mcpClient.callTool({
        name: "record_food_feedback",
        arguments: { placeSlug: "test-cafe", itemId: "dish-1", signal: "liked" },
      });
      expect(recorded.structuredContent).toMatchObject({
        preference: { placeSlug: "test-cafe", itemId: "dish-1", liked: true, orderCount: 0 },
      });
      const preferences = await mcpClient.callTool({ name: "get_food_preferences", arguments: {} });
      expect(preferences.structuredContent).toMatchObject({
        preferences: [{ placeSlug: "test-cafe", itemId: "dish-1", liked: true }],
      });
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});

async function createTestConnection() {
  const directory = await mkdtemp(join(tmpdir(), "yandex-eats-mcp-contract-"));
  temporaryDirectories.push(directory);
  const config = loadConfig({
    NODE_ENV: "test", MCP_AUTH_MODE: "none", MCP_STATE_DIR: directory,
    YANDEX_EATS_COOKIE_FILE: join(directory, "missing-cookie"),
  });
  const logger = createLogger("silent");
  const eatsClient = new YandexEatsClient(config, logger, () => Promise.reject(new Error("No upstream requests expected")));
  await eatsClient.initialize();
  const recommendations = new RecommendationService(eatsClient, new FoodPreferenceStore(directory, logger), logger);
  const server = createYandexEatsMcpServer(eatsClient, config, logger, undefined, recommendations);
  const mcpClient = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  return { eatsClient, recommendations, mcpClient, close: async () => {
    await mcpClient.close();
    await server.close();
  } };
}
