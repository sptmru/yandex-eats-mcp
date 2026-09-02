import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { YandexEatsClient } from "../src/eats/client.js";
import { createLogger } from "../src/logger.js";
import { createYandexEatsMcpServer } from "../src/mcp/server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP contract", () => {
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
      const events = listed.tools.find((tool) => tool.name === "get_order_events");
      expect(events?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
      const recommendations = listed.tools.find((tool) => tool.name === "recommend_food");
      expect(recommendations?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
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
