/**
 * Client-safe helpers for the fixed store sections.
 *
 * The coupons section accepts BOTH Airtable "Store Section" values `Cards`
 * (legacy) and `Coupons` (new) as aliases of one section, and keeps the stable
 * section id `store-section-cards` so existing caches stay valid.
 */

export const COUPONS_SECTION_ID = "store-section-cards";

export interface FixedSectionDef {
  key: string;
  id: string;
  nameEn: string;
  nameAr: string;
  /** Lowercased Airtable "Store Section" values that map to this section. */
  aliases: string[];
}

/** Fixed sections that come before the point-category sections. */
export const FIXED_SECTIONS: FixedSectionDef[] = [
  {
    key: "coupons",
    id: COUPONS_SECTION_ID,
    nameEn: "Coupons",
    nameAr: "الكوبونات",
    aliases: ["cards", "coupons"],
  },
  {
    key: "cashback",
    id: "store-section-cashback",
    nameEn: "Cashback",
    nameAr: "استرداد نقدي",
    aliases: ["cashback"],
  },
];

/** Fixed-section key for a normalized (lowercased, trimmed) section value. */
export function fixedSectionKey(normalized: string): string | null {
  const match = FIXED_SECTIONS.find((s) => s.aliases.includes(normalized));
  return match ? match.key : null;
}

/**
 * Display labels for a category, so payloads cached before the rename still
 * render as Coupons / الكوبونات.
 */
export function storeCategoryLabels(category: {
  id: string;
  nameEn: string;
  nameAr: string;
}): { nameEn: string; nameAr: string } {
  const legacyCoupons =
    category.id === COUPONS_SECTION_ID ||
    ["cards", "coupons"].includes(category.nameEn.trim().toLowerCase()) ||
    ["البطاقات", "الكوبونات"].includes(category.nameAr.trim());
  if (legacyCoupons) return { nameEn: "Coupons", nameAr: "الكوبونات" };
  return { nameEn: category.nameEn, nameAr: category.nameAr };
}
