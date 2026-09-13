import { describe, expect, it } from "vitest";

import {
  COUPONS_SECTION_ID,
  FIXED_SECTIONS,
  fixedSectionKey,
  storeCategoryLabels,
} from "@/lib/store-sections";

describe("store fixed sections", () => {
  it("accepts both Cards and Coupons as the same section", () => {
    expect(fixedSectionKey("cards")).toBe("coupons");
    expect(fixedSectionKey("coupons")).toBe("coupons");
    expect(fixedSectionKey("cashback")).toBe("cashback");
    expect(fixedSectionKey("10-24 points")).toBeNull();
  });

  it("keeps the stable coupons section id and displays Coupons", () => {
    const coupons = FIXED_SECTIONS.find((s) => s.key === "coupons")!;
    expect(coupons.id).toBe(COUPONS_SECTION_ID);
    expect(coupons.id).toBe("store-section-cards");
    expect(coupons.nameEn).toBe("Coupons");
    expect(coupons.nameAr).toBe("الكوبونات");
  });

  it("renders cached Cards labels as Coupons", () => {
    expect(
      storeCategoryLabels({ id: "store-section-cards", nameEn: "Cards", nameAr: "البطاقات" }),
    ).toEqual({ nameEn: "Coupons", nameAr: "الكوبونات" });
    expect(
      storeCategoryLabels({ id: "store-section-cards", nameEn: "Coupons", nameAr: "الكوبونات" }),
    ).toEqual({ nameEn: "Coupons", nameAr: "الكوبونات" });
  });

  it("leaves other categories untouched", () => {
    expect(storeCategoryLabels({ id: "rec1", nameEn: "10-24 Points", nameAr: "١٠-٢٤ نقطة" })).toEqual(
      { nameEn: "10-24 Points", nameAr: "١٠-٢٤ نقطة" },
    );
    expect(
      storeCategoryLabels({ id: "store-section-cashback", nameEn: "Cashback", nameAr: "استرداد نقدي" }),
    ).toEqual({ nameEn: "Cashback", nameAr: "استرداد نقدي" });
  });
});
