import type { OrderEvent } from "../types.js";
import type { OrderNotifier } from "./notifier.js";

type FetchLike = typeof fetch;

export class TelegramOrderNotifier implements OrderNotifier {
  readonly provider = "telegram" as const;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImplementation: FetchLike = fetch,
  ) {}

  async send(event: OrderEvent, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchImplementation(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: formatTelegramEvent(event),
        disable_web_page_preview: true,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Telegram notification failed (${response.status})`);
  }
}

export function formatTelegramEvent(event: OrderEvent): string {
  const masked = event.orderNr ? maskOrderNumber(event.orderNr) : undefined;
  const heading = event.type.startsWith("monitor.") ? "Yandex Eats monitor" : `Yandex Eats order ${masked ?? ""}`.trim();
  const waitText = event.current?.terminal ? undefined : event.current?.etaText ?? event.current?.title;
  const wait = waitText ? `\nОжидание: ${waitText}` : "";
  return `${heading}\n${event.summary}${wait}`;
}

function maskOrderNumber(orderNr: string): string {
  const suffix = orderNr.slice(-4);
  return suffix ? `***${suffix}` : "***";
}
