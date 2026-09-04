/**
 * Read-only mapping from Airtable's "Store" and "Store Category" tables.
 *
 * SAFETY: this module only ever issues GET requests and never mutates Airtable.
 * Categories are fully dynamic — nothing about them is hardcoded here.
 */
import type { StoreCategorySection, StoreItem } from "@/data/types";

import { AIRTABLE_TABLES, listAirtableRecords, optNumeric, str } from "./airtable.server";

const linkIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Extract the lower bound of a category point range so categories can be
 * sorted from lowest to highest. Handles range ("10–24 Points", "10-24 نقطة")
 * and single-value ("100 Points") names. Returns Infinity when no number is
 * found so unparseable categories sort after numeric ones without changing
 * their relative order.
 */
const categoryLowerBound = (nameEn: string, nameAr: string): number => {
  const matches = [...`${nameEn} ${nameAr}`.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) =>
    Number(m[0].replace(",", ".")),
  );
  return matches.length > 0 ? Math.min(...matches) : Infinity;
};

const firstImageUrl = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (item && typeof item === "object") {
      const att = item as { url?: unknown; thumbnails?: { large?: { url?: unknown } } };
      const large = att.thumbnails?.large?.url;
      if (typeof large === "string" && large) return large;
      if (typeof att.url === "string" && att.url) return att.url;
    }
  }
  return null;
};

/** Website-visible store products grouped by their linked Airtable category. */
export async function fetchStoreFromAirtable(): Promise<StoreCategorySection[]> {
  const [productRows, categoryRows] = await Promise.all([
    listAirtableRecords(AIRTABLE_TABLES.store),
    listAirtableRecords(AIRTABLE_TABLES.storeCategories),
  ]);

  const sections = new Map<string, StoreCategorySection>();
  for (const row of categoryRows) {
    const nameEn = str(row.fields["Category EN"]);
    const nameAr = str(row.fields["Category AR"]);
    if (!nameEn && !nameAr) continue;
    sections.set(row.id, { id: row.id, nameEn, nameAr, products: [] });
  }

  for (const row of productRows) {
    if (row.fields["Show On Website"] !== true) continue;

    const nameEn = str(row.fields["Product Name EN"]);
    const nameAr = str(row.fields["Product Name AR"]);
    if (!nameEn && !nameAr) continue;

    const product: StoreItem = {
      id: row.id,
      nameEn,
      nameAr,
      descriptionEn: str(row.fields["Description En"]) || str(row.fields["Description EN"]),
      descriptionAr: str(row.fields["Description AR"]),
      requiredPoints: optNumeric(row.fields["Required Points"]),
      imageUrl: firstImageUrl(row.fields["Product Image"]),
    };

    for (const categoryId of linkIds(row.fields["Category"])) {
      const section = sections.get(categoryId);
      if (section) section.products.push(product);
    }
  }

  for (const section of sections.values()) {
    section.products.sort((a, b) => (a.requiredPoints ?? 0) - (b.requiredPoints ?? 0));
  }

  return [...sections.values()]
    .filter((section) => section.products.length > 0)
    .sort(
      (a, b) =>
        categoryLowerBound(a.nameEn, a.nameAr) - categoryLowerBound(b.nameEn, b.nameAr),
    );
}

