import { EatsError } from "../../mcp/errors.js";
import type { CartSummary, NormalizedCart } from "../schemas.js";
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  compactStrings,
  firstDefined,
} from "./common.js";

export function mapCartResponse(raw: unknown): NormalizedCart {
  const root = asRecord(raw);
  const cart = asRecord(root?.cart) ?? asRecord(root?.payload) ?? root;
  if (!cart || !Array.isArray(cart.items)) {
    throw new EatsError("UPSTREAM_BAD_RESPONSE", "Cart returned an invalid response.");
  }
  const place = asRecord(cart.place);
  const currencyRecord = asRecord(cart.currency);
  const requirements = asRecord(cart.requirements);
  return {
    ...(asString(firstDefined(cart, ["place_slug", "placeSlug"])) ?? asString(place?.slug)
      ? { placeSlug: asString(firstDefined(cart, ["place_slug", "placeSlug"])) ?? asString(place?.slug) }
      : {}),
    ...(asString(firstDefined(cart, ["group_slug", "groupSlug"]))
      ? { groupSlug: asString(firstDefined(cart, ["group_slug", "groupSlug"])) }
      : {}),
    ...(asString(firstDefined(cart, ["shipping_type", "shippingType"]))
      ? { shippingType: asString(firstDefined(cart, ["shipping_type", "shippingType"])) }
      : {}),
    ...(asString(firstDefined(currencyRecord, ["code", "sign"]))
      ? { currency: asString(firstDefined(currencyRecord, ["code", "sign"])) }
      : {}),
    items: cart.items
      .map((value) => {
        const cartItem = asRecord(value);
        const product = asRecord(firstDefined(cartItem, ["item", "product"]));
        const cartItemId = asString(firstDefined(cartItem, ["id", "cart_item_id", "cartItemId"]));
        const name =
          asString(firstDefined(cartItem, ["name", "title"])) ??
          asString(firstDefined(product, ["name", "title"]));
        if (!cartItemId || !name) return undefined;
        const itemId =
          asString(firstDefined(cartItem, ["item_id", "itemId"])) ??
          asString(firstDefined(product, ["id", "item_id", "itemId"]));
        const optionRecords = asArray(firstDefined(cartItem, ["item_options", "itemOptions", "options"]));
        return {
          cartItemId,
          ...(itemId ? { itemId } : {}),
          name,
          quantity: asNumber(cartItem?.quantity) ?? 1,
          ...(asNumber(firstDefined(cartItem, ["decimal_price", "unit_price", "unitPrice"])) !== undefined
            ? { unitPrice: asNumber(firstDefined(cartItem, ["decimal_price", "unit_price", "unitPrice"])) }
            : {}),
          ...(asNumber(firstDefined(cartItem, ["decimal_total", "total_price", "totalPrice"])) !== undefined
            ? { totalPrice: asNumber(firstDefined(cartItem, ["decimal_total", "total_price", "totalPrice"])) }
            : {}),
          adult: asBoolean(cartItem?.adult) || asBoolean(product?.adult),
          options: optionRecords.flatMap((option) => {
            const record = asRecord(option);
            return compactStrings([
              firstDefined(record, ["group_name", "groupName", "name"]),
              ...asArray(firstDefined(record, ["options", "group_options", "groupOptions"])),
            ]);
          }),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== undefined),
    ...(asNumber(firstDefined(cart, ["decimal_subtotal", "decimalSubtotal", "subtotal"])) !== undefined
      ? { subtotal: asNumber(firstDefined(cart, ["decimal_subtotal", "decimalSubtotal", "subtotal"])) }
      : {}),
    ...(asNumber(firstDefined(cart, ["decimal_discount", "decimalDiscount", "discount"])) !== undefined
      ? { discount: asNumber(firstDefined(cart, ["decimal_discount", "decimalDiscount", "discount"])) }
      : {}),
    ...(asNumber(firstDefined(cart, ["decimal_delivery_fee", "decimalDeliveryFee", "delivery_fee"])) !== undefined
      ? { deliveryFee: asNumber(firstDefined(cart, ["decimal_delivery_fee", "decimalDeliveryFee", "delivery_fee"])) }
      : {}),
    ...(asNumber(firstDefined(cart, ["decimal_total", "decimalTotal", "total"])) !== undefined
      ? { total: asNumber(firstDefined(cart, ["decimal_total", "decimalTotal", "total"])) }
      : {}),
    violatedConstraints: compactStrings(
      asArray(firstDefined(requirements, ["violated_constraints", "violatedConstraints"])),
    ),
    ...(asString(firstDefined(cart, ["updated_at", "updatedAt"]))
      ? { updatedAt: asString(firstDefined(cart, ["updated_at", "updatedAt"])) }
      : {}),
  };
}

export function mapCartSummaries(raw: unknown): CartSummary[] {
  const root = asRecord(raw);
  if (!root || !Array.isArray(root.carts)) {
    throw new EatsError("UPSTREAM_BAD_RESPONSE", "Cart list returned an invalid response.");
  }
  return root.carts.map((value) => {
    const cart = asRecord(value);
    const items = asArray(cart?.items);
    const currency = asRecord(cart?.currency);
    return {
      ...(asString(firstDefined(cart, ["place_slug", "placeSlug"]))
        ? { placeSlug: asString(firstDefined(cart, ["place_slug", "placeSlug"])) }
        : {}),
      ...(asString(firstDefined(cart, ["group_slug", "groupSlug"]))
        ? { groupSlug: asString(firstDefined(cart, ["group_slug", "groupSlug"])) }
        : {}),
      ...(asString(firstDefined(cart, ["title", "name"]))
        ? { name: asString(firstDefined(cart, ["title", "name"])) }
        : {}),
      itemCount: asNumber(firstDefined(cart, ["items_count", "itemsCount"])) ?? items.length,
      ...(asNumber(firstDefined(cart, ["decimal_total", "decimalTotal", "total"])) !== undefined
        ? { total: asNumber(firstDefined(cart, ["decimal_total", "decimalTotal", "total"])) }
        : {}),
      ...(asString(firstDefined(currency, ["code", "sign"]))
        ? { currency: asString(firstDefined(currency, ["code", "sign"])) }
        : {}),
    };
  });
}

