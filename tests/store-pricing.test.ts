/** M3 only. All data reads are mocked; run separately from other module-mocking suites. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoreCategorySection, StoreItem } from "../src/data/types";
import type { AirtableRecord } from "../src/lib/airtable.server";
import { contactInfo } from "../src/data/site";
import { getStorePrice, parseStorePoints } from "../src/lib/store-pricing";

const actualAirtable = await import("../src/lib/airtable.server");
const { AIRTABLE_TABLES, optNumeric } = actualAirtable;
let productRows: AirtableRecord[] = [];
let categoryRows: AirtableRecord[] = [];
let categories: StoreCategorySection[] = [];
let lang: "en" | "ar" = "en";
let reads: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("Real network access is forbidden in M3 tests"); }) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

mock.module("../src/lib/airtable.server", () => ({
  ...actualAirtable,
  listAirtableRecords: async (table: string) => {
    reads.push(table);
    if (table === AIRTABLE_TABLES.store) return productRows;
    if (table === AIRTABLE_TABLES.storeCategories) return categoryRows;
    throw new Error("Unexpected Airtable table");
  },
}));
mock.module("@tanstack/react-query", () => ({ useSuspenseQuery: () => ({ data: categories }) }));
mock.module("../src/lib/store-query", () => ({ storeQueryOptions: {} }));
mock.module("../src/lib/i18n", () => ({
  useI18n: () => ({ lang, t: (key: string) => key === "store.order" ? (lang === "ar" ? "طلب المنتج" : "Order Product") : key }),
}));
mock.module("../src/components/ui-kit", () => ({
  PageShell: ({ children }: { children: ReactNode }) => createElement("main", null, children),
  PageHeader: () => createElement("header"),
}));

const { fetchStoreFromAirtable } = await import("../src/lib/store.server");
const { Route } = await import("../src/routes/store");
const StorePage = Route.options.component as ComponentType;

beforeEach(() => {
  productRows = [];
  categoryRows = [{ id: "category", fields: { "Category EN": "10 Points", "Category AR": "10 نقاط" } }];
  categories = [];
  reads = [];
  lang = "en";
});

function row(id: string, required: unknown, discount?: unknown): AirtableRecord {
  return { id, fields: {
    "Product Name EN": "Product " + id,
    "Product Name AR": "منتج " + id,
    "Show On Website": true,
    "Required Points": required,
    "Discount Points": discount,
    Category: ["category"],
  } };
}

function renderStore() {
  return renderToStaticMarkup(createElement(StorePage));
}

function links(html: string) {
  return [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1]!.replaceAll("&amp;", "&")));
}

function expectPrice(html: string, numericLabel: string, discounted: boolean) {
  const label = `${numericLabel} ${lang === "ar" ? "نقاط" : "Points"}`;
  // Both badge and full price must carry the same effective value.
  expect(html.split(label).length - 1).toBe(2);
  expect(html.includes("line-through")).toBe(discounted);
  const orderLinks = links(html);
  expect(orderLinks.length).toBe(1);
  expect(orderLinks[0]!.origin + orderLinks[0]!.pathname).toBe(`https://wa.me/${contactInfo.whatsappNumber}`);
  const message = orderLinks[0]!.searchParams.get("text")!;
  expect(message.split("\n").at(-1)).toBe(`${lang === "ar" ? "النقاط المطلوبة" : "Required Points"}: ${label}`);
  expect(message).toContain(lang === "ar" ? "منتج fixture" : "Product fixture");
  expect(html).not.toContain("disabled=");
}

describe("Store-only numeric parsing", () => {
  for (const [input, expected] of [
    [100, 100], [0, 0], [-10, -10], [12.3456789, 12.3456789],
    ["100", 100], ["  12.3456789  ", 12.3456789], [".5", 0.5],
    ["-10", -10], ["0", 0], ["1e2", 100],
  ] as const) {
    test(`whole numeric value ${JSON.stringify(input)} preserves its value`, () => {
      expect(parseStorePoints(input)).toBe(expected);
    });
  }
  for (const [label, input] of [
    ["missing", undefined], ["null", null], ["empty", ""], ["blank", "  "],
    ["letters", "abc"], ["mixed", "12abc"], ["units", "100 Points"],
    ["grouped text", "1,000"], ["hex", "0x10"], ["range", "10-20"],
    ["multiple decimals", "1.2.3"], ["Infinity text", "Infinity"], ["NaN text", "NaN"],
    ["overflow", "1e999"], ["boolean", true], ["array", [12]], ["object", { value: 12 }],
    ["NaN", NaN], ["infinity", Infinity], ["negative infinity", -Infinity],
  ] as const) {
    test(`${label} is unavailable rather than coerced into a price`, () => {
      expect(parseStorePoints(input)).toBeNull();
    });
  }
  test("the shared optNumeric parser retains its previous behavior", () => {
    expect(optNumeric("abc")).toBe(0);
    expect(optNumeric("12abc")).toBe(12);
    expect(optNumeric(undefined)).toBeNull();
    expect(optNumeric(0)).toBe(0);
  });
});

describe("authoritative effective price", () => {
  test("a discount is a replacement price, without subtraction or mutation", () => {
    const product = Object.freeze({ requiredPoints: 100, discountPoints: 70 });
    expect(getStorePrice(product)).toEqual({ originalPoints: 100, effectivePoints: 70, discounted: true });
    expect(product).toEqual({ requiredPoints: 100, discountPoints: 70 });
  });
  for (const discount of [null, 0, -5, 100, 150, NaN, Infinity, -Infinity]) {
    test(`invalid discount ${String(discount)} uses the valid original`, () => {
      expect(getStorePrice({ requiredPoints: 100, discountPoints: discount })).toEqual({
        originalPoints: 100, effectivePoints: 100, discounted: false,
      });
    });
  }
  for (const original of [null, 0, -5, NaN, Infinity, -Infinity]) {
    test(`invalid original ${String(original)} is unavailable even with a positive discount`, () => {
      expect(getStorePrice({ requiredPoints: original, discountPoints: 1 })).toBeNull();
    });
  }
  test("malformed runtime values cannot bypass price validity", () => {
    expect(getStorePrice({ requiredPoints: "12abc", discountPoints: 1 } as unknown as StoreItem)).toBeNull();
    expect(getStorePrice({ requiredPoints: 100, discountPoints: "12abc" } as unknown as StoreItem))
      .toEqual({ originalPoints: 100, effectivePoints: 100, discounted: false });
  });
});

const validCases = [
  { name: "no discount", original: 100, discount: undefined, labels: ["100", "١٠٠"], discounted: false },
  { name: "null discount", original: 100, discount: null, labels: ["100", "١٠٠"], discounted: false },
  { name: "valid discount", original: 100, discount: 70, labels: ["70", "٧٠"], discounted: true },
  { name: "equal discount", original: 100, discount: 100, labels: ["100", "١٠٠"], discounted: false },
  { name: "greater discount", original: 100, discount: 150, labels: ["100", "١٠٠"], discounted: false },
  { name: "zero discount", original: 100, discount: 0, labels: ["100", "١٠٠"], discounted: false },
  { name: "negative discount", original: 100, discount: -20, labels: ["100", "١٠٠"], discounted: false },
  { name: "malformed discount", original: 100, discount: "12abc", labels: ["100", "١٠٠"], discounted: false },
  { name: "non-finite discount", original: 100, discount: Infinity, labels: ["100", "١٠٠"], discounted: false },
  { name: "blank discount", original: 100, discount: "  ", labels: ["100", "١٠٠"], discounted: false },
  { name: "decimal original", original: 12.3456789, discount: null, labels: ["12.3456789", "١٢٫٣٤٥٦٧٨٩"], discounted: false },
  { name: "decimal discount", original: 100, discount: "12.3456789", labels: ["12.3456789", "١٢٫٣٤٥٦٧٨٩"], discounted: true },
  { name: "grouped numeric price", original: 1234.56789, discount: null, labels: ["1,234.56789", "١٬٢٣٤٫٥٦٧٨٩"], discounted: false },
  { name: "small decimal", original: 1, discount: 1e-21, labels: ["0.000000000000000000001", "٠٫٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠١"], discounted: true },
  { name: "full precision decimal", original: 1.2345678901234567, discount: null, labels: ["1.2345678901234567", "١٫٢٣٤٥٦٧٨٩٠١٢٣٤٥٦٧"], discounted: false },
];

for (const language of ["en", "ar"] as const) {
  describe(`${language}: actual Airtable mapping, Store rendering and WhatsApp message`, () => {
    for (const scenario of validCases) {
      test(`${scenario.name}: display and order message match exactly`, async () => {
        lang = language;
        productRows = [row("fixture", scenario.original, scenario.discount)];
        categories = await fetchStoreFromAirtable();
        expect(reads).toEqual([AIRTABLE_TABLES.store, AIRTABLE_TABLES.storeCategories]);
        expect(categories[0]!.products.length).toBe(1);
        expectPrice(renderStore(), scenario.labels[language === "en" ? 0 : 1]!, scenario.discounted);
      });
    }
    for (const [label, original] of [
      ["missing", undefined], ["null", null], ["blank", ""], ["zero", 0],
      ["negative", -10], ["malformed", "abc"], ["mixed", "12abc"],
      ["non-finite", Infinity], ["NaN", NaN],
    ] as const) {
      test(`${label} original remains visible with a disabled order control`, async () => {
        lang = language;
        productRows = [row("fixture", original, 1)];
        categories = await fetchStoreFromAirtable();
        const html = renderStore();
        expect(categories[0]!.products.length).toBe(1);
        expect(html).toContain(language === "ar" ? "منتج fixture" : "Product fixture");
        expect(html).toContain(language === "ar" ? "السعر غير متاح" : "Price unavailable");
        // Check the product card, not its category heading (e.g. "10 Points").
        const card = html.match(/<article\b[\s\S]*?<\/article>/)![0];
        expect(card).not.toContain(language === "ar" ? "٠ نقاط" : "0 Points");
        expect(links(html)).toEqual([]);
        expect(html).not.toContain("wa.me");
        expect(html).toMatch(/<button[^>]*disabled=""/);
        expect(html).not.toContain("line-through");
      });
    }
  });
}

describe("unchanged Store grouping, sorting and links", () => {
  test("all sections sort by ORIGINAL required points despite inverted discount ordering", async () => {
    for (const section of ["Cards", "Cashback", ""]) {
      const high = row(section + "high", 100, 1);
      const low = row(section + "low", 10, 9);
      high.fields["Store Section"] = section;
      low.fields["Store Section"] = section;
      productRows.push(high, low);
    }
    categories = await fetchStoreFromAirtable();
    expect(categories.map(c => c.id)).toEqual(["store-section-cards", "store-section-cashback", "category"]);
    for (const category of categories) {
      expect(category.products.map(p => p.requiredPoints)).toEqual([10, 100]);
      expect(category.products.map(p => getStorePrice(p)!.effectivePoints)).toEqual([9, 1]);
    }
    expect(reads.length).toBe(2);
  });

  test("missing and non-positive originals keep existing sort behavior and remain visible", async () => {
    productRows = [row("valid", 100), row("missing", undefined), row("negative", -10), row("zero", 0)];
    categories = await fetchStoreFromAirtable();
    expect(categories[0]!.products.map(p => p.id)).toEqual(["negative", "missing", "zero", "valid"]);
    expect(links(renderStore()).length).toBe(1);
  });

  test("Where to Buy is never read, mapped, or used by order links", async () => {
    const product = row("fixture", 100, 70);
    Object.defineProperty(product.fields, "Where to Buy", {
      enumerable: true,
      get() { throw new Error("Where to Buy must stay ignored"); },
    });
    productRows = [product];
    categories = await fetchStoreFromAirtable();
    const mapped = categories[0]!.products[0]!;
    expect(Object.keys(mapped).sort()).toEqual([
      "descriptionAr", "descriptionEn", "discountPoints", "id", "imageUrl", "nameAr", "nameEn", "requiredPoints",
    ]);
    expectPrice(renderStore(), "70", true);
  });

  test("Store visibility, names, descriptions, images and category membership remain unchanged", async () => {
    const visible = row("fixture", 100, 70);
    Object.assign(visible.fields, {
      "Description En": "Description", "Description AR": "وصف",
      "Product Image": [{ url: "https://images.test/image.png", thumbnails: { large: { url: "https://images.test/large.png" } } }],
    });
    const hidden = row("hidden", 10);
    hidden.fields["Show On Website"] = false;
    const unnamed = row("unnamed", 10);
    unnamed.fields["Product Name EN"] = "";
    unnamed.fields["Product Name AR"] = "";
    productRows = [hidden, unnamed, visible];
    categories = await fetchStoreFromAirtable();
    expect(categories.length).toBe(1);
    expect(categories[0]!.products).toEqual([{
      id: "fixture", nameEn: "Product fixture", nameAr: "منتج fixture",
      descriptionEn: "Description", descriptionAr: "وصف", requiredPoints: 100, discountPoints: 70,
      imageUrl: "https://images.test/large.png",
    }]);
  });
});
