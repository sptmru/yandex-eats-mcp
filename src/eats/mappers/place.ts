import { EatsError } from "../../mcp/errors.js";
import type { NormalizedPlace } from "../schemas.js";
import { asArray, asBoolean, asNumber, asRecord, asString, firstDefined } from "./common.js";

export function mapPlaceResponse(raw: unknown): NormalizedPlace {
  const root = asRecord(raw);
  const payload = asRecord(root?.payload);
  const foundPlace = asRecord(firstDefined(payload, ["foundPlace", "found_place"]));
  const place = asRecord(foundPlace?.place);
  const location = asRecord(firstDefined(foundPlace, ["locationParams", "location_params"]));
  const placeSlug = asString(firstDefined(place, ["slug", "place_slug"]));
  const name = asString(firstDefined(place, ["name", "title"]));
  if (!placeSlug || !name || !location) {
    throw new EatsError("UPSTREAM_BAD_RESPONSE", "Place details returned an invalid response.");
  }
  const delivery = asRecord(firstDefined(location, ["deliveryTime", "delivery_time"]));
  const currency = asRecord(place?.currency);
  return {
    placeSlug,
    name,
    business: asString(place?.business) ?? "restaurant",
    ...(asNumber(place?.rating) !== undefined ? { rating: asNumber(place?.rating) } : {}),
    ...(asString(firstDefined(currency, ["code", "sign"]))
      ? { currency: asString(firstDefined(currency, ["code", "sign"])) }
      : {}),
    available: asBoolean(location.available),
    availableNow: asBoolean(firstDefined(location, ["availableNow", "available_now"])),
    ...(firstDefined(location, ["availableFrom", "available_from"]) !== undefined
      ? { availableFrom: asString(firstDefined(location, ["availableFrom", "available_from"])) ?? null }
      : {}),
    ...(firstDefined(location, ["availableTo", "available_to"]) !== undefined
      ? { availableTo: asString(firstDefined(location, ["availableTo", "available_to"])) ?? null }
      : {}),
    ...(asNumber(firstDefined(delivery, ["min", "minimum"])) !== undefined
      ? { deliveryTimeMin: asNumber(firstDefined(delivery, ["min", "minimum"])) }
      : {}),
    ...(asNumber(firstDefined(delivery, ["max", "maximum"])) !== undefined
      ? { deliveryTimeMax: asNumber(firstDefined(delivery, ["max", "maximum"])) }
      : {}),
    shippingTypes: asArray(firstDefined(location, ["availableShippingTypes", "available_shipping_types"]))
      .map((value) => asString(asRecord(value)?.type))
      .filter((value): value is string => Boolean(value)),
  };
}

