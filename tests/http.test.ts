import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { YandexEatsClient } from "../src/eats/client.js";
import { createHttpApp } from "../src/http/app.js";
import { createLogger } from "../src/logger.js";
import { createInactiveOrderMonitorService } from "../src/orders/order-monitor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Streamable HTTP server", () => {
  it("cancels an upstream recommendation search when its HTTP connection is aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-eats-http-cancellation-"));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      NODE_ENV: "test", MCP_AUTH_MODE: "none", HOST: "127.0.0.1", MCP_STATE_DIR: directory,
      YANDEX_EATS_COOKIE_FILE: join(directory, "missing-cookie"),
      YANDEX_EATS_LATITUDE: "40.18", YANDEX_EATS_LONGITUDE: "44.51",
    });
    const logger = createLogger("silent");
    let upstreamSignal: AbortSignal | null | undefined;
    let releaseUpstream: (() => void) | undefined;
    const client = new YandexEatsClient(config, logger, (_url, init) => new Promise<Response>((resolve, reject) => {
      upstreamSignal = init?.signal;
      releaseUpstream = () => resolve(new Response(JSON.stringify({ blocks: [] }), {
        headers: { "content-type": "application/json" },
      }));
      upstreamSignal?.addEventListener("abort", () => reject(new Error("Upstream cancelled")), { once: true });
    }));
    await client.initialize();
    const server = createServer(await createHttpApp(config, client, logger));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const caller = new AbortController();
    try {
      const pending = fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST", signal: caller.signal,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "search_items", arguments: { queries: ["salad"] } } }),
      }).then((response) => response.text());
      const rejected = expect(pending).rejects.toBeDefined();
      await vi.waitFor(() => expect(upstreamSignal).toBeDefined(), { interval: 5 });
      caller.abort();
      await rejected;
      await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true), { interval: 5 });
    } finally {
      caller.abort();
      releaseUpstream?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("returns 503 for an enabled unhealthy monitor while preserving liveness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-eats-readiness-"));
    temporaryDirectories.push(directory);
    const config = loadConfig({ NODE_ENV: "test", MCP_AUTH_MODE: "none", MCP_STATE_DIR: directory,
      YANDEX_EATS_ENABLE_ORDER_MONITORING: "true" });
    const logger = createLogger("silent");
    const client = new YandexEatsClient(config, logger, () => Promise.reject(new Error("No upstream request expected")));
    const monitor = createInactiveOrderMonitorService(config);
    const health = monitor.getHealth();
    monitor.getHealth = () => health;
    const server = createServer(await createHttpApp(config, client, logger, monitor));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      let readiness = await fetch(`${base}/readyz`);
      expect(readiness.status).toBe(503);
      expect(await readiness.json()).toMatchObject({ status: "degraded", monitorHealthy: false });
      expect((await fetch(`${base}/healthz`)).status).toBe(200);

      health.monitorHealthy = true;
      readiness = await fetch(`${base}/readyz`);
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toMatchObject({ status: "ready" });

      health.monitorHealthy = false;
      health.authExpired = true;
      readiness = await fetch(`${base}/readyz`);
      expect(readiness.status).toBe(503);
      expect(await readiness.json()).toMatchObject({ authExpired: true });

      health.monitorEnabled = false;
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("serves health and completes a stateless MCP handshake", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-eats-mcp-http-"));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      MCP_AUTH_MODE: "none",
      MCP_STATE_DIR: directory,
      YANDEX_EATS_COOKIE_FILE: join(directory, "missing-cookie"),
    });
    const logger = createLogger("silent");
    const eatsClient = new YandexEatsClient(config, logger, () =>
      Promise.reject(new Error("No upstream request expected")),
    );
    await eatsClient.initialize();
    const app = await createHttpApp(config, eatsClient, logger);
    const httpServer = createServer(app);
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    const address = httpServer.address() as AddressInfo;
    const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
    const mcpClient = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl));

    try {
      const health = await fetch(new URL("/healthz", baseUrl));
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      await mcpClient.connect(transport as unknown as Transport);
      const tools = await mcpClient.listTools();
      expect(tools.tools.some((tool) => tool.name === "search")).toBe(true);
      const result = await mcpClient.callTool({ name: "server_capabilities", arguments: {} });
      expect(result.structuredContent).toMatchObject({ placeOrderEnabled: false });
    } finally {
      await mcpClient.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("publishes OAuth discovery and completes the single-user PKCE token flow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-eats-mcp-oauth-http-"));
    temporaryDirectories.push(directory);
    const passwordFile = join(directory, "oauth-password");
    await writeFile(passwordFile, "correct-owner-password", { mode: 0o600 });
    const externalBase = "https://eats-mcp.example.com";
    const resource = `${externalBase}/mcp`;
    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: externalBase,
      MCP_AUTH_MODE: "oauth",
      MCP_OAUTH_PASSWORD_FILE: passwordFile,
      MCP_STATE_DIR: directory,
      YANDEX_EATS_COOKIE_FILE: join(directory, "missing-cookie"),
    });
    const logger = createLogger("silent");
    const eatsClient = new YandexEatsClient(config, logger, () =>
      Promise.reject(new Error("No upstream request expected")),
    );
    await eatsClient.initialize();
    const app = await createHttpApp(config, eatsClient, logger);
    const httpServer = createServer(app);
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    const address = httpServer.address() as AddressInfo;
    const localBase = new URL(`http://127.0.0.1:${address.port}`);

    try {
      const metadataResponse = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", localBase));
      expect(metadataResponse.status).toBe(200);
      expect(await metadataResponse.json()).toMatchObject({
        resource,
        authorization_servers: [`${externalBase}/`],
        scopes_supported: ["mcp:tools"],
      });

      const unauthorized = await fetch(new URL("/mcp", localBase), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");

      const redirectUri = "https://chatgpt.com/connector/callback";
      const registration = await fetch(new URL("/register", localBase), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          client_name: "ChatGPT OAuth Test",
        }),
      });
      expect(registration.status).toBe(201);
      const registered = (await registration.json()) as { client_id: string };
      expect(registered.client_id).toBeTruthy();

      const verifier = "v".repeat(64);
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const authorizeUrl = new URL("/authorize", localBase);
      authorizeUrl.search = new URLSearchParams({
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "mcp:tools",
        state: "test-state",
        resource,
      }).toString();
      const authorization = await fetch(authorizeUrl);
      expect(authorization.status).toBe(200);
      expect(authorization.headers.get("content-security-policy")).toContain(
        "form-action 'self' https://chatgpt.com",
      );
      const approvalPage = await authorization.text();
      expect(approvalPage).toContain("Authorize Yandex Eats MCP");
      const pending = /name="pending" value="([^"]+)"/.exec(approvalPage)?.[1];
      expect(pending).toBeTruthy();

      const approval = await fetch(new URL("/oauth/approve", localBase), {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ pending: pending ?? "", password: "correct-owner-password" }),
      });
      expect(approval.status).toBe(302);
      const callback = new URL(approval.headers.get("location") ?? "https://invalid.example");
      expect(callback.origin + callback.pathname).toBe(redirectUri);
      expect(callback.searchParams.get("state")).toBe("test-state");
      const code = callback.searchParams.get("code");
      expect(code).toBeTruthy();

      const tokenResponse = await fetch(new URL("/token", localBase), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: registered.client_id,
          code: code ?? "",
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource,
        }),
      });
      expect(tokenResponse.status).toBe(200);
      expect(await tokenResponse.json()).toMatchObject({
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp:tools",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
