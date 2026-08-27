import { describe, expect, it } from "vitest";

import { mapCartResponse, mapCartSummaries } from "../src/eats/mappers/cart.js";
import { mapMenuResponse } from "../src/eats/mappers/menu.js";
import { mapSearchResponse } from "../src/eats/mappers/search.js";

describe("mapSearchResponse", () => {
  it("normalizes place and item data while applying availability and size limits", () => {
    const raw = {
      currency: { code: "AMD", sign: "֏" },
      pagination: { context: "next-page" },
      blocks: [
        { type: "filters", payload: { ignored: true } },
        {
          type: "places",
          payload: [
            {
              slug: "cafe-one",
              title: "Cafe One",
              business: "restaurant",
              available: true,
              delivery: { text: "25–35 min" },
              price_category: { title: "$$" },
              lower_meta: [{ text: "4.8" }],
              chips: [{ text: "Free delivery" }, { title: "Free delivery" }],
              items: [
                {
                  id: 101,
                  public_id: "dish-101",
                  title: "Soup",
                  decimal_price: "1 250,50 AMD",
                  weight: "350 g",
                  adult: false,
                  has_required_option_groups: true,
                },
                { id: 102, title: "Salad", decimal_price: "950" },
              ],
            },
            {
              slug: "closed-cafe",
              title: "Closed Cafe",
              available: false,
              items: [],
            },
            {
              slug: "cafe-two",
              title: "Cafe Two",
              available: true,
              items: [{ id: 201, title: "Tea", decimal_price: "500" }],
            },
          ],
        },
      ],
    };

    expect(mapSearchResponse(raw, "lunch", 1, 1, false)).toEqual({
      query: "lunch",
      currency: "AMD",
      cursor: "next-page",
      places: [
        {
          placeSlug: "cafe-one",
          name: "Cafe One",
          business: "restaurant",
          available: true,
          eta: "25–35 min",
          rating: "4.8",
          priceCategory: "$$",
          promos: ["Free delivery"],
          items: [
            {
              itemId: "101",
              publicId: "dish-101",
              name: "Soup",
              price: 1250.5,
              currency: "AMD",
              weight: "350 g",
              adult: false,
              hasRequiredOptions: true,
            },
          ],
        },
      ],
    });
  });

  it("can retain unavailable places and rejects invalid response roots", () => {
    const raw = {
      currency: { sign: "֏" },
      blocks: [
        {
          type: "places",
          payload: [{ place_slug: "closed", name: "Closed", available: false }],
        },
      ],
    };

    expect(mapSearchResponse(raw, "query", 10, 5, true).places).toEqual([
      {
        placeSlug: "closed",
        name: "Closed",
        business: "restaurant",
        available: false,
        promos: [],
        items: [],
      },
    ]);
    expect(() => mapSearchResponse(null, "query", 10, 5, false)).toThrow(
      "Search returned an invalid response.",
    );
  });
});

describe("mapMenuResponse", () => {
  it("normalizes nested categories, stock, and required option groups", () => {
    const raw = {
      payload: {
        currency: { code: "AMD" },
        categories: [
          {
            id: 10,
            name: "Main",
            available: true,
            items: [
              {
                id: 1001,
                publicId: "main-1001",
                name: "Rice bowl",
                description: "Rice and vegetables",
                decimalPrice: "2 400",
                weight: "420 g",
                available: true,
                inStock: 3,
                adult: false,
                shippingType: "delivery",
                optionsGroups: [
                  {
                    id: 501,
                    name: "Sauce",
                    required: true,
                    minSelected: 1,
                    maxSelected: 2,
                    options: [
                      {
                        id: 601,
                        name: "Mild",
                        decimalPrice: "150",
                        multiplier: 1,
                      },
                    ],
                  },
                ],
              },
            ],
            categories: [
              {
                category_id: "11",
                title: "Sides",
                items: [
                  {
                    item_id: "1002",
                    title: "Bread",
                    decimal_price: "300",
                    options_groups: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    expect(mapMenuResponse(raw, "cafe-one")).toEqual({
      placeSlug: "cafe-one",
      currency: "AMD",
      categories: [
        {
          categoryId: "10",
          name: "Main",
          available: true,
          items: [
            {
              itemId: "1001",
              publicId: "main-1001",
              name: "Rice bowl",
              description: "Rice and vegetables",
              price: 2400,
              currency: "AMD",
              weight: "420 g",
              available: true,
              inStock: 3,
              adult: false,
              shippingType: "delivery",
              optionGroups: [
                {
                  groupId: "501",
                  name: "Sauce",
                  required: true,
                  minSelected: 1,
                  maxSelected: 2,
                  options: [
                    {
                      optionId: "601",
                      name: "Mild",
                      price: 150,
                      multiplier: 1,
                    },
                  ],
                },
              ],
            },
          ],
          categories: [
            {
              categoryId: "11",
              name: "Sides",
              available: true,
              items: [
                {
                  itemId: "1002",
                  name: "Bread",
                  price: 300,
                  currency: "AMD",
                  available: true,
                  adult: false,
                  optionGroups: [],
                },
              ],
              categories: [],
            },
          ],
        },
      ],
    });
  });

  it("uses the fallback currency and rejects responses without categories", () => {
    expect(mapMenuResponse({ payload: { categories: [] } }, "cafe", "USD")).toEqual({
      placeSlug: "cafe",
      currency: "USD",
      categories: [],
    });
    expect(() => mapMenuResponse({ payload: {} }, "cafe")).toThrow(
      "Menu returned an invalid response.",
    );
  });
});

describe("cart mappers", () => {
  it("normalizes a server cart snapshot", () => {
    const raw = {
      cart: {
        place: { slug: "cafe-one" },
        group_slug: "group-one",
        shipping_type: "delivery",
        currency: { code: "AMD" },
        items: [
          {
            cart_item_id: 9001,
            item_id: 1001,
            title: "Rice bowl",
            quantity: 2,
            decimal_price: "2 400",
            decimal_total: "4 800",
            adult: false,
            item_options: [
              {
                group_name: "Sauce",
                group_options: [601],
              },
            ],
          },
        ],
        decimal_subtotal: "4 800",
        decimal_discount: "300",
        decimal_delivery_fee: "500",
        decimal_total: "5 000",
        requirements: {
          violated_constraints: [{ text: "Minimum order not reached" }],
        },
        updated_at: "2026-08-27T12:00:00Z",
      },
    };

    expect(mapCartResponse(raw)).toEqual({
      placeSlug: "cafe-one",
      groupSlug: "group-one",
      shippingType: "delivery",
      currency: "AMD",
      items: [
        {
          cartItemId: "9001",
          itemId: "1001",
          name: "Rice bowl",
          quantity: 2,
          unitPrice: 2400,
          totalPrice: 4800,
          adult: false,
          options: ["Sauce", "601"],
        },
      ],
      subtotal: 4800,
      discount: 300,
      deliveryFee: 500,
      total: 5000,
      violatedConstraints: ["Minimum order not reached"],
      updatedAt: "2026-08-27T12:00:00Z",
    });
  });

  it("normalizes parallel cart summaries", () => {
    expect(
      mapCartSummaries({
        carts: [
          {
            place_slug: "cafe-one",
            title: "Cafe One",
            items_count: 2,
            decimal_total: "5 000",
            currency: { code: "AMD" },
          },
          {
            groupSlug: "market-group",
            name: "Market",
            items: [{}, {}, {}],
            total: 3200,
            currency: { sign: "֏" },
          },
        ],
      }),
    ).toEqual([
      {
        placeSlug: "cafe-one",
        name: "Cafe One",
        itemCount: 2,
        total: 5000,
        currency: "AMD",
      },
      {
        groupSlug: "market-group",
        name: "Market",
        itemCount: 3,
        total: 3200,
        currency: "֏",
      },
    ]);
  });

  it("rejects invalid cart response shapes", () => {
    expect(() => mapCartResponse({ cart: {} })).toThrow(
      "Cart returned an invalid response.",
    );
    expect(() => mapCartSummaries({ carts: null })).toThrow(
      "Cart list returned an invalid response.",
    );
  });
});
