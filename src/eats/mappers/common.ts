export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function firstDefined(record: UnknownRecord | undefined, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const normalized = value.replace(/\s/g, "").replace(",", ".").replace(/[^0-9.+-]/g, "");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function compactStrings(values: unknown[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    const record = asRecord(value);
    const text =
      asString(value) ??
      asString(firstDefined(record, ["text", "title", "name", "label", "value"]));
    if (text) result.add(text);
  }
  return [...result];
}

export function requireRecord(value: unknown, message: string): UnknownRecord {
  const record = asRecord(value);
  if (!record) throw new Error(message);
  return record;
}

