import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import * as React from "react";
import { getStorePrice } from "../src/lib/store-pricing";
import { contactInfo } from "../src/data/site";

const require = createRequire(import.meta.url);
let failed = false;
let lang = "en";
const module = { exports: {} as Record<string, any> };
const source = readFileSync("src/routes/store.tsx", "utf8");
const code = ts.transpileModule(source + "\nexport {ProductImage, ProductCard, CategorySection};", {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
  if (name === "react") return { ...React, useState: () => [failed, (value: boolean) => { failed = value; }] };
  if (name.startsWith("react/")) return require(name);
  if (name === "@tanstack/react-router") return { createFileRoute: () => (options: unknown) => options };
  if (name === "@/lib/i18n") return { useI18n: () => ({ lang, t: (key: string) => key }) };
  if (name === "@/lib/store-pricing") return { getStorePrice };
  if (name === "@/data/site") return { contactInfo };
  if (name === "lucide-react") return { ShoppingBag: "shopping-bag", Sparkles: "sparkles", ArrowUpRight: "arrow" };
  return {};
} });
const { ProductImage, ProductCard, CategorySection } = module.exports;
const product = { id: "one", nameEn: "Ball", nameAr: "كرة", descriptionEn: "", descriptionAr: "", requiredPoints: 20.5, discountPoints: null, imageUrl: "/one.png" };
const image = (url: string | null) => ProductImage({ url, name: "Ball" });
const imageElement = (p = product) => ProductCard({ product: p }).props.children[0].props.children[0];
function visit(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(visit);
  if (!node?.props) return [];
  return [node, ...visit(node.props.children)];
}
beforeEach(() => { failed = false; lang = "en"; });
test("missing URL uses the original placeholder", () => {
  const node = image(null);
  expect(node.type).toBe("div");
  expect(node.props["aria-hidden"]).toBe(true);
  expect(node.props.className).toBe("grid h-full place-items-center text-gold/70");
  expect(node.props.children.type).toBe("shopping-bag");
  expect(node.props.children.props.strokeWidth).toBe(1.25);
});
test("valid URL retains source, alt text, lazy loading and styling", () => {
  const node = image("/one.png");
  expect(node.type).toBe("img");
  expect(node.props.src).toBe("/one.png");
  expect(node.props.alt).toBe("Ball");
  expect(node.props.loading).toBe("lazy");
  expect(node.props.className).toContain("object-contain");
});
test("load error reuses exactly the missing-URL placeholder", () => {
  const placeholder = image(null);
  image("/bad.png").props.onError();
  expect(image("/bad.png")).toEqual(placeholder);
});
test("URL changes replace the keyed image component, including returning to an older URL", () => {
  const a = imageElement();
  const b = imageElement({ ...product, imageUrl: "/two.png" });
  expect(a.key).not.toBe(b.key);
  expect(imageElement().key).toBe(a.key);
  expect(imageElement({ ...product, id: "other" }).key).not.toBe(a.key);
  expect(a.type).toBe(ProductImage);
});
test("a newly mounted URL starts unfailed and can fail gracefully", () => {
  image("/bad.png").props.onError();
  expect(image("/bad.png").type).toBe("div");
  failed = false; // React resets useState when the ProductImage key changes.
  expect(image("/new.png").type).toBe("img");
  image("/new.png").props.onError();
  expect(image("/new.png").type).toBe("div");
});
for (const language of ["en", "ar"]) {
  for (const discountPoints of [null, 10.25]) {
    test(`${language}, discount ${discountPoints}: image failure preserves price and exact order link`, () => {
      lang = language;
      const p = { ...product, discountPoints };
      const before = visit(ProductCard({ product: p }));
      image(p.imageUrl).props.onError();
      const after = visit(ProductCard({ product: p }));
      expect(after.find(node => node.type === "a").props.href).toBe(before.find(node => node.type === "a").props.href);
      const prices = after.filter(node => node.props.variant).map(node => node.props.price);
      expect(prices).toEqual([getStorePrice(p), getStorePrice(p)]);
      expect(prices[0].effectivePoints).toBe(discountPoints ?? 20.5);
    });
  }
}
test("category product order remains unchanged", () => {
  const products = [{ ...product, id: "expensive", requiredPoints: 100 }, { ...product, id: "cheap", requiredPoints: 10 }];
  const tree = CategorySection({ category: { id: "category", nameEn: "Items", nameAr: "منتجات", products } });
  expect(visit(tree).filter(node => node.type === ProductCard).map(node => node.props.product.id)).toEqual(["expensive", "cheap"]);
});
