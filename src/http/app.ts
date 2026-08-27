import express, { type Express, type RequestHandler } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "pino";
import { readSecretFile, type AppConfig } from "../config.js";
import type { YandexEatsClient } from "../eats/client.js";
import { createYandexEatsMcpServer } from "../mcp/server.js";
import { SingleUserOAuthProvider, StaticBearerVerifier } from "../auth/single-user-oauth.js";
import { createInactiveOrderMonitorService, type OrderMonitorService } from "../orders/order-monitor.js";

export async function createHttpApp(
  config: AppConfig,
  client: YandexEatsClient,
  logger: Logger,
  orderMonitor: OrderMonitorService = createInactiveOrderMonitorService(config),
): Promise<Express> {
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (config.publicBaseUrl) allowedHosts.add(config.publicBaseUrl.hostname);
  const app = createMcpExpressApp({ host: config.host, allowedHosts: [...allowedHosts] });
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use((req, res, next) => {
    if (!isOAuthDiagnosticPath(req.path)) {
      next();
      return;
    }
    const startedAt = Date.now();
    const ip = req.ip;
    const method = req.method;
    const path = req.path;
    res.on("finish", () => {
      logger.info(
        {
          ip,
          method,
          path,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
        },
        "MCP OAuth HTTP request",
      );
    });
    next();
  });

  const authMiddleware = await configureAuth(app, config, logger);

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/readyz", (_req, res) => {
    const health = orderMonitor.getHealth();
    res.status(200).json({
      status: "ready",
      monitorEnabled: health.monitorEnabled,
      monitorHealthy: health.monitorHealthy,
      authExpired: health.authExpired,
      ...(health.lastSuccessfulPollAt ? { lastSuccessfulPollAt: health.lastSuccessfulPollAt } : {}),
    });
  });
  app.get("/", (_req, res) => {
    res.status(200).json({
      name: "yandex-eats-mcp",
      version: "0.1.0",
      mcp: "/mcp",
      checkoutEnabled: false,
      placeOrderEnabled: false,
    });
  });

  app.post("/mcp", authMiddleware, async (req, res) => {
    const server = createYandexEatsMcpServer(client, config, logger, orderMonitor);
    const transport = new StreamableHTTPServerTransport();
    try {
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to handle MCP request");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  };
  app.get("/mcp", authMiddleware, methodNotAllowed);
  app.delete("/mcp", authMiddleware, methodNotAllowed);

  return app;
}

function isOAuthDiagnosticPath(path: string): boolean {
  return (
    path === "/authorize" ||
    path === "/token" ||
    path === "/register" ||
    path === "/revoke" ||
    path === "/oauth/approve" ||
    path.startsWith("/.well-known/")
  );
}

async function configureAuth(app: Express, config: AppConfig, logger: Logger): Promise<RequestHandler> {
  if (config.auth.mode === "none") return (_req, _res, next) => next();

  if (config.auth.mode === "bearer") {
    const token = readSecretFile(config.auth.bearerTokenFile, "MCP bearer token secret");
    return requireBearerAuth({
      verifier: new StaticBearerVerifier(token),
      requiredScopes: ["mcp:tools"],
    });
  }

  if (!config.publicBaseUrl) throw new Error("PUBLIC_BASE_URL is required for OAuth mode");
  const password = readSecretFile(config.auth.oauthPasswordFile, "MCP OAuth password secret");
  const issuerUrl = new URL(config.publicBaseUrl.href);
  issuerUrl.pathname = "/";
  const resourceUrl = new URL("/mcp", issuerUrl);
  const provider = new SingleUserOAuthProvider(config.stateDir, password, resourceUrl, logger);
  await provider.initialize();

  app.post(
    "/oauth/approve",
    express.urlencoded({ extended: false, limit: "8kb" }),
    (req, res) => void provider.approve(req, res),
  );
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: resourceUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "Personal Yandex Eats MCP",
      serviceDocumentationUrl: new URL("/", issuerUrl),
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  return requireBearerAuth({
    verifier: provider,
    requiredScopes: ["mcp:tools"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });
}
