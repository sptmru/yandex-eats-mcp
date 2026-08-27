import { createHash } from "node:crypto";
import type { NormalizedOrderStatus, OrderPhase } from "./types.js";

type UnknownRecord = Record<string, unknown>;

const PHASE_ALIASES: Record<string, OrderPhase> = {
  accepted: "accepted",
  confirmed: "accepted",
  cooking: "preparing",
  preparing: "preparing",
  courier_assigned: "courier_assigned",
  courier_found: "courier_assigned",
  picked_up: "picked_up",
  courier_picked_up: "picked_up",
  arriving: "arriving",
  near: "arriving",
  delivered: "delivered",
  completed: "delivered",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const MACHINE_STATUS_KEYS = new Set(["status", "state", "phase", "order_status", "delivery_status"]);
const PROGRESS_KEYS = new Set(["progress_key", "progress_id", "current_step", "current_step_id", "stage", "step"]);
const ETA_KEYS = new Set(["eta", "eta_text", "delivery_time", "delivery_time_text", "time_window"]);

export function orderNumberFromRaw(value: unknown): string | undefined {
  return findString(value, new Set(["order_nr", "order_number"]));
}

export function orderHasTrackingWidgets(value: unknown): boolean {
  const record = asRecord(value);
  return Array.isArray(record?.widgets) && record.widgets.length > 0;
}

export function normalizeOrderStatus(raw: unknown, fallbackOrderNr?: string): NormalizedOrderStatus | undefined {
  const orderNr = orderNumberFromRaw(raw) ?? fallbackOrderNr;
  if (!orderNr) return undefined;
  const machineStatus = normalizeToken(findString(raw, MACHINE_STATUS_KEYS));
  const progressKey = normalizeToken(findString(raw, PROGRESS_KEYS));
  const etaText = cleanText(findString(raw, ETA_KEYS));
  const title = cleanText(findDisplayText(raw, "title"));
  const subtitle = cleanText(findDisplayText(raw, "subtitle"));
  const courierAssigned = hasMeaningfulKey(raw, new Set(["courier", "courier_info", "courier_status"]));
  const phase = mapPhase(machineStatus, progressKey);
  const terminal = phase === "delivered" || phase === "cancelled";
  const fingerprintPayload = {
    machineStatus,
    progressKey,
    etaText,
    courierAssigned,
    title: normalizeDisplayText(title),
    subtitle: normalizeDisplayText(subtitle),
  };
  const fingerprint = createHash("sha256").update(stableStringify(fingerprintPayload)).digest("hex");
  return {
    orderNr,
    phase,
    terminal,
    ...(title ? { title } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(etaText ? { etaText } : {}),
    ...(progressKey ? { progressKey } : {}),
    courierAssigned,
    updatedAt: new Date().toISOString(),
    fingerprint,
  };
}

function mapPhase(machineStatus?: string, progressKey?: string): OrderPhase {
  for (const token of [machineStatus, progressKey]) {
    if (!token) continue;
    if (PHASE_ALIASES[token]) return PHASE_ALIASES[token];
  }
  return "unknown";
}

function findString(value: unknown, keys: Set<string>, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findString(entry, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const [key, entry] of Object.entries(record)) {
    if (keys.has(key.toLocaleLowerCase())) {
      const text = primitiveText(entry);
      if (text) return text;
    }
  }
  for (const entry of Object.values(record)) {
    const found = findString(entry, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findDisplayText(value: unknown, key: "title" | "subtitle", depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDisplayText(entry, key, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  if (key in record) {
    const text = displayText(record[key]);
    if (text) return text;
  }
  for (const entry of Object.values(record)) {
    const found = findDisplayText(entry, key, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function displayText(value: unknown, depth = 0): string | undefined {
  const direct = primitiveText(value);
  if (direct) return direct;
  if (depth > 3) return undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["text", "value", "label"]) {
    if (key in record) {
      const found = displayText(record[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function hasMeaningfulKey(value: unknown, keys: Set<string>, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.some((entry) => hasMeaningfulKey(entry, keys, depth + 1));
  const record = asRecord(value);
  if (!record) return false;
  for (const [key, entry] of Object.entries(record)) {
    if (keys.has(key.toLocaleLowerCase()) && entry !== null && entry !== false && entry !== "") return true;
  }
  return Object.values(record).some((entry) => hasMeaningfulKey(entry, keys, depth + 1));
}

function primitiveText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function cleanText(value?: string): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim().slice(0, 300);
  return text || undefined;
}

function normalizeDisplayText(value?: string): string | undefined {
  return value?.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeToken(value?: string): string | undefined {
  return value?.trim().toLocaleLowerCase().replace(/[\s-]+/g, "_").slice(0, 120) || undefined;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function stableStringify(value: UnknownRecord): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))));
}
