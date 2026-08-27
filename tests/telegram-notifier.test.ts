import { describe, expect, it, vi } from "vitest";
import { TelegramOrderNotifier, formatTelegramEvent } from "../src/orders/notifiers/telegram.js";
import type { OrderEvent } from "../src/orders/types.js";

describe("TelegramOrderNotifier", () => {
  it("sends a masked, minimal notification", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: requestUrl(input), ...(init ? { init } : {}) });
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const notifier = new TelegramOrderNotifier("secret-token", "12345", fakeFetch);
    const event = sampleEvent();

    await notifier.send(event);

    expect(calls[0]?.input).toBe("https://api.telegram.org/botsecret-token/sendMessage");
    const body = JSON.parse(requestBody(calls[0]?.init?.body)) as { chat_id: string; text: string };
    expect(body.chat_id).toBe("12345");
    expect(body.text).toContain("***6789");
    expect(body.text).toContain("Ожидание: 20 min");
    expect(body.text).not.toContain("123456789");
    expect(body.text).not.toContain("courier-name");
  });

  it("formats monitor events without an order number", () => {
    expect(formatTelegramEvent({
      id: "11111111-1111-4111-8111-111111111111",
      sequence: 1,
      occurredAt: "2026-08-27T00:00:00.000Z",
      type: "monitor.recovered",
      summary: "Recovered.",
    })).toBe("Yandex Eats monitor\nRecovered.");
  });

  it("includes current waiting time in status events and the new value in ETA events", () => {
    const statusEvent = sampleEvent();
    statusEvent.current = {
      ...statusEvent.current!,
      title: "Ещё 20–25 минут",
      subtitle: "Курьер уже спешит к вам",
      etaText: undefined,
    };
    expect(formatTelegramEvent(statusEvent)).toContain("Ожидание: Ещё 20–25 минут");

    const etaEvent = { ...statusEvent, type: "order.eta_changed" as const };
    etaEvent.current = { ...statusEvent.current, title: "Ещё 15–20 минут" };
    expect(formatTelegramEvent(etaEvent)).toContain("Ожидание: Ещё 15–20 минут");
  });
});

function sampleEvent(): OrderEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    sequence: 1,
    occurredAt: "2026-08-27T00:00:00.000Z",
    type: "order.status_changed",
    orderNr: "123456789",
    summary: "Order status changed: preparing.",
    current: {
      orderNr: "123456789",
      phase: "preparing",
      terminal: false,
      etaText: "20 min",
      courierAssigned: true,
      updatedAt: "2026-08-27T00:00:00.000Z",
      fingerprint: "fingerprint",
    },
  };
}

function requestUrl(input: string | URL | Request): string {
  if (input instanceof Request) return input.url;
  return input instanceof URL ? input.href : input;
}

function requestBody(body: unknown): string {
  return typeof body === "string" ? body : "null";
}
