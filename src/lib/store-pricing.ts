import type { StoreItem } from "@/data/types";

/** Store-only parsing: accept a whole numeric value, never strip arbitrary text. */
export function parseStorePoints(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface StorePrice {
  originalPoints: number;
  effectivePoints: number;
  discounted: boolean;
}

/** One price decision for both the card and its WhatsApp request. */
export function getStorePrice(
  product: Pick<StoreItem, "requiredPoints" | "discountPoints">,
): StorePrice | null {
  const original = product.requiredPoints;
  if (typeof original !== "number" || !Number.isFinite(original) || original <= 0) return null;
  const discount = product.discountPoints;
  const discounted = typeof discount === "number" && Number.isFinite(discount) &&
    discount > 0 && discount < original;
  return {
    originalPoints: original,
    effectivePoints: discounted ? discount : original,
    discounted,
  };
}
