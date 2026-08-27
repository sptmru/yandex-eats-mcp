import { createServer, type Server } from "node:http";
import { loadConfig } from "./config.js";
import { YandexEatsClient } from "./eats/client.js";
import { createHttpApp } from "./http/app.js";
import { createLogger } from "./logger.js";
import { createOrderApi, OrderMonitor } from "./orders/order-monitor.js";
import { createOrderNotifier } from "./orders/notifiers/notifier.js";
import { OrderNotifierQueue } from "./orders/notifiers/queue.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const client = new YandexEatsClient(config, logger);
  await client.initialize();
  const notifier = createOrderNotifier(config);
  const notifierQueue = new OrderNotifierQueue(notifier, logger);
  const orderMonitor = new OrderMonitor(createOrderApi(client), config, notifierQueue, notifier.provider, logger);
  await orderMonitor.initialize();
  const app = await createHttpApp(config, client, logger, orderMonitor);
  const server = createServer(app);

  await listen(server, config.port, config.host);
  await orderMonitor.start();
  logger.info(
    {
      host: config.host,
      port: config.port,
      authMode: config.auth.mode,
      mutationsEnabled: config.eats.mutationsEnabled,
      orderMonitoringEnabled: config.orders.enabled,
      orderNotifier: notifier.provider,
    },
    "Yandex Eats MCP server started",
  );

  process.on("SIGHUP", () => {
    void client.session.reloadCookie().then((loaded) => {
      logger.info({ cookieLoaded: loaded }, "Reloaded Yandex Eats cookie secret");
      orderMonitor.wake();
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down Yandex Eats MCP server");
    void Promise.all([orderMonitor.stop(), closeServer(server)]).catch((error: unknown) => {
      logger.error({ err: error }, "Graceful shutdown failed");
      process.exitCode = 1;
    });
    setTimeout(() => {
      logger.error("Forced shutdown after grace period");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

main().catch((error: unknown) => {
  const logger = createLogger("error");
  logger.fatal({ err: error }, "Yandex Eats MCP server failed to start");
  process.exit(1);
});
