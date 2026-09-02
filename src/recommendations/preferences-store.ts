import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { foodPreferenceSchema, type FoodPreference } from "./types.js";

const persistedSchema = z.object({
  version: z.literal(1),
  preferences: z.array(foodPreferenceSchema),
});

export type FoodFeedbackInput = {
  placeSlug: string;
  placeName?: string | undefined;
  itemId?: string | undefined;
  itemName?: string | undefined;
  signal: "liked" | "disliked" | "ordered" | "rated";
  rating?: number | undefined;
  orderedAt?: string | undefined;
};

export class FoodPreferenceStore {
  private readonly path: string;
  private preferences: FoodPreference[] = [];
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(stateDir: string, private readonly logger: Logger) {
    this.path = join(stateDir, "food-preferences.json");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const parsed = persistedSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      this.preferences = parsed.preferences;
    } catch (error) {
      if (!isMissingFile(error)) this.logger.warn({ err: error }, "Ignoring invalid food preference state");
      this.preferences = [];
    }
    this.initialized = true;
  }

  async list(): Promise<FoodPreference[]> {
    await this.initialize();
    return structuredClone(this.preferences).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async record(input: FoodFeedbackInput): Promise<FoodPreference> {
    await this.initialize();
    if (input.signal === "rated" && input.rating === undefined) {
      throw new Error("rating is required when signal is rated");
    }
    let result: FoodPreference | undefined;
    await this.enqueue(async () => {
      const index = this.preferences.findIndex(
        (entry) => entry.placeSlug === input.placeSlug && entry.itemId === input.itemId,
      );
      const previous = index >= 0 ? this.preferences[index] : undefined;
      const now = new Date().toISOString();
      result = {
        placeSlug: input.placeSlug,
        ...(input.placeName ?? previous?.placeName ? { placeName: input.placeName ?? previous?.placeName } : {}),
        ...(input.itemId ? { itemId: input.itemId } : {}),
        ...(input.itemName ?? previous?.itemName ? { itemName: input.itemName ?? previous?.itemName } : {}),
        ...(input.signal === "liked" ? { liked: true } : {}),
        ...(input.signal === "disliked" ? { liked: false } : {}),
        ...(input.signal !== "liked" && input.signal !== "disliked" && previous?.liked !== undefined
          ? { liked: previous.liked }
          : {}),
        ...(input.rating ?? previous?.rating ? { rating: input.rating ?? previous?.rating } : {}),
        orderCount: (previous?.orderCount ?? 0) + (input.signal === "ordered" ? 1 : 0),
        ...(input.signal === "ordered"
          ? { lastOrderedAt: input.orderedAt ?? now }
          : previous?.lastOrderedAt
            ? { lastOrderedAt: previous.lastOrderedAt }
            : {}),
        updatedAt: now,
      };
      if (index >= 0) this.preferences[index] = result;
      else this.preferences.push(result);
      await this.persist();
    });
    if (!result) throw new Error("Food preference was not recorded");
    return structuredClone(result);
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.catch(() => undefined);
    await next;
  }

  private async persist(): Promise<void> {
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, preferences: this.preferences }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, this.path);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
