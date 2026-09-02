import { EatsError } from "../../mcp/errors.js";
import type { NormalizedMenu, NormalizedMenuCategory, NormalizedMenuItem } from "../schemas.js";
import { asArray, asBoolean, asNumber, asRecord, asString, firstDefined } from "./common.js";

export function mapMenuResponse(raw: unknown, placeSlug: string, fallbackCurrency = "AMD"): NormalizedMenu {
  const root = asRecord(raw);
  const payload = asRecord(root?.payload);
  if (!payload || !Array.isArray(payload.categories)) {
    throw new EatsError("UPSTREAM_BAD_RESPONSE", "Menu returned an invalid response.");
  }
  const currencyRecord = asRecord(payload.currency);
  const rawCurrency = asString(firstDefined(currencyRecord, ["code", "sign"]));
  const currency = rawCurrency === "֏" ? "AMD" : rawCurrency ?? fallbackCurrency;
  return {
    placeSlug,
    currency,
    categories: payload.categories
      .map((value) => mapCategory(value, currency))
      .filter((value): value is NormalizedMenuCategory => value !== undefined),
  };
}

function mapCategory(value: unknown, currency: string): NormalizedMenuCategory | undefined {
  const category = asRecord(value);
  const categoryId = asString(firstDefined(category, ["id", "category_id", "categoryId"]));
  const name = asString(firstDefined(category, ["name", "title"]));
  if (!categoryId || !name) return undefined;
  return {
    categoryId,
    name,
    available: asBoolean(category?.available, true),
    items: asArray(category?.items)
      .map((item) => mapItem(item, currency))
      .filter((item): item is NormalizedMenuItem => item !== undefined),
    categories: asArray(category?.categories)
      .map((child) => mapCategory(child, currency))
      .filter((child): child is NormalizedMenuCategory => child !== undefined),
  };
}

function mapItem(value: unknown, currency: string): NormalizedMenuItem | undefined {
  const item = asRecord(value);
  const itemId = asString(firstDefined(item, ["id", "item_id", "itemId"]));
  const name = asString(firstDefined(item, ["name", "title"]));
  const price = asNumber(firstDefined(item, ["decimalPrice", "decimal_price", "price"]));
  if (!itemId || !name || price === undefined) return undefined;
  const publicId = asString(firstDefined(item, ["publicId", "public_id"]));
  const description = asString(item?.description);
  const weight = asString(item?.weight);
  const inStock = asNumber(firstDefined(item, ["inStock", "in_stock"]));
  const shippingType = asString(firstDefined(item, ["shippingType", "shipping_type"]));
  return {
    itemId,
    ...(publicId ? { publicId } : {}),
    name,
    ...(description ? { description } : {}),
    price,
    currency,
    ...(weight ? { weight } : {}),
    available: asBoolean(item?.available, true),
    ...(firstDefined(item, ["inStock", "in_stock"]) !== undefined
      ? { inStock: inStock ?? null }
      : {}),
    adult: asBoolean(item?.adult),
    ...(shippingType ? { shippingType } : {}),
    optionGroups: asArray(firstDefined(item, ["optionsGroups", "options_groups"]))
      .map((groupValue) => {
        const group = asRecord(groupValue);
        const groupId = asString(firstDefined(group, ["id", "group_id", "groupId"]));
        const groupName = asString(firstDefined(group, ["name", "title"]));
        if (!groupId || !groupName) return undefined;
        return {
          groupId,
          name: groupName,
          required: asBoolean(group?.required),
          minSelected: asNumber(firstDefined(group, ["minSelected", "min_selected"])) ?? 0,
          maxSelected: asNumber(firstDefined(group, ["maxSelected", "max_selected"])) ?? 1,
          options: asArray(group?.options)
            .map((optionValue) => {
              const option = asRecord(optionValue);
              const optionId = asString(firstDefined(option, ["id", "option_id", "optionId"]));
              const optionName = asString(firstDefined(option, ["name", "title"]));
              if (!optionId || !optionName) return undefined;
              return {
                optionId,
                name: optionName,
                price: asNumber(firstDefined(option, ["decimalPrice", "decimal_price", "price"])) ?? 0,
                multiplier: asNumber(option?.multiplier) ?? 1,
              };
            })
            .filter((option): option is NonNullable<typeof option> => option !== undefined),
        };
      })
      .filter((group): group is NonNullable<typeof group> => group !== undefined),
  };
}
