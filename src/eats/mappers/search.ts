import { EatsError } from "../../mcp/errors.js";
import type { NormalizedSearch } from "../schemas.js";
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  compactStrings,
  firstDefined,
} from "./common.js";

export function mapSearchResponse(
  raw: unknown,
  query: string,
  maxPlaces: number,
  maxItemsPerPlace: number,
  includeUnavailable: boolean,
): NormalizedSearch {
  const root = asRecord(raw);
  if (!root) {
    throw new EatsError("UPSTREAM_BAD_RESPONSE", "Search returned an invalid response.");
  }

  const currencyRecord = asRecord(root.currency);
  const rawCurrency = asString(firstDefined(currencyRecord, ["code", "sign", "text"]));
  const currency = rawCurrency === "֏" ? "AMD" : rawCurrency ?? "AMD";
  const pagination = asRecord(root.pagination);
  const cursor = asString(pagination?.context);
  const places: NormalizedSearch["places"] = [];

  for (const blockValue of asArray(root.blocks)) {
    const block = asRecord(blockValue);
    if (asString(block?.type) !== "places") continue;
    for (const placeValue of asArray(block?.payload)) {
      const place = asRecord(placeValue);
      const placeSlug = asString(firstDefined(place, ["slug", "place_slug"]));
      const name = asString(firstDefined(place, ["title", "name"]));
      if (!placeSlug || !name) continue;
      const available = asBoolean(place?.available, true);
      if (!includeUnavailable && !available) continue;

      const delivery = asRecord(place?.delivery);
      const priceCategory = asRecord(firstDefined(place, ["price_category", "priceCategory"]));
      const items = asArray(place?.items)
        .map((value) => mapSearchItem(value, currency))
        .filter((value): value is NonNullable<typeof value> => value !== undefined)
        .slice(0, maxItemsPerPlace);
      const rating = findRating(place ?? {});
      places.push({
        placeSlug,
        name,
        business: asString(place?.business) ?? "restaurant",
        available,
        ...(asString(delivery?.text) ? { eta: asString(delivery?.text) } : {}),
        ...(rating ? { rating } : {}),
        ...(asString(priceCategory?.title)
          ? { priceCategory: asString(priceCategory?.title) }
          : {}),
        promos: compactStrings(asArray(place?.chips)),
        items,
      });
      if (places.length >= maxPlaces) break;
    }
    if (places.length >= maxPlaces) break;
  }

  return { query, currency, ...(cursor ? { cursor } : {}), places };
}

function mapSearchItem(value: unknown, currency: string): NormalizedSearch["places"][number]["items"][number] | undefined {
  const item = asRecord(value);
  const itemId = asString(firstDefined(item, ["id", "item_id", "itemId"]));
  const name = asString(firstDefined(item, ["title", "name"]));
  const price = asNumber(firstDefined(item, ["decimal_price", "decimalPrice", "price"]));
  if (!itemId || !name || price === undefined) return undefined;
  const publicId = asString(firstDefined(item, ["public_id", "publicId"]));
  const weight = asString(item?.weight);
  return {
    itemId,
    ...(publicId ? { publicId } : {}),
    name,
    price,
    currency,
    ...(weight ? { weight } : {}),
    adult: asBoolean(item?.adult),
    hasRequiredOptions: asBoolean(
      firstDefined(item, ["has_required_option_groups", "hasRequiredOptionGroups"]),
    ),
  };
}

function findRating(place: Record<string, unknown>): string | undefined {
  const direct = asString(firstDefined(place, ["rating", "rating_text"]));
  if (direct) return direct;
  for (const value of asArray(firstDefined(place, ["lower_meta", "lowerMeta"]))) {
    const record = asRecord(value);
    const text = asString(firstDefined(record, ["text", "title", "value"]));
    if (text && /\d[.,]\d/.test(text)) return text;
  }
  return undefined;
}
