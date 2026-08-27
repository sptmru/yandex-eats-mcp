import type { OrderEvent } from "../types.js";
import { readSecretFile, type AppConfig } from "../../config.js";
import { TelegramOrderNotifier } from "./telegram.js";

export interface OrderNotifier {
  readonly provider: "none" | "telegram";
  send(event: OrderEvent, signal?: AbortSignal): Promise<void>;
}

export class NoopOrderNotifier implements OrderNotifier {
  readonly provider = "none" as const;
  send(_event: OrderEvent, _signal?: AbortSignal): Promise<void> {
    return Promise.resolve();
  }
}

export function createOrderNotifier(config: AppConfig): OrderNotifier {
  if (config.orders.notifier.provider === "none") return new NoopOrderNotifier();
  const token = readSecretFile(config.orders.notifier.telegramTokenFile, "Telegram bot token secret");
  const chatId = readSecretFile(config.orders.notifier.telegramChatIdFile, "Telegram chat ID secret");
  if (!/^\d{6,15}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("Telegram bot token secret has an invalid format");
  if (!/^-?\d+$/.test(chatId)) throw new Error("Telegram chat ID secret has an invalid format");
  return new TelegramOrderNotifier(token, chatId);
}
