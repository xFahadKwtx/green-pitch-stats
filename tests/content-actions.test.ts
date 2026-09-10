import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import * as React from "react";
import ts from "typescript";
import { contactInfo } from "../src/data/site";
import { MONTHS } from "../src/data/types";
const require = createRequire(import.meta.url);
const source = (path: string) => readFileSync(path, "utf8");
let lang = "en";
let categories: unknown[] = [];
function load(path: string, extra = "", translations: any = {}) {
  const module = { exports: {} as Record<string, any> };
  const code = ts.transpileModule(source(path) + extra, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (name === "react" || name.startsWith("react/")) return require(name);
    if (name === "@tanstack/react-query") return { useSuspenseQuery: () => ({ data: categories }) };
    if (name === "@tanstack/react-router") return { createFileRoute: () => (options: unknown) => options };
    if (name === "@/lib/i18n") return { useI18n: () => ({ lang, t: (key: string) => translations[lang][key] }) };
    if (name === "@/data/site") return { contactInfo };
    return {};
  } });
  return module.exports;
}
const { dict } = load("src/lib/i18n.tsx", "\nexport {dict};");
const { StorePage } = load("src/routes/store.tsx", "\nexport {StorePage};", dict);
function visit(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(visit);
  return node?.props ? [node, ...visit(node.props.children)] : [];
}
const message = "السلام عليكم، أرغب باستخدام ميزة Freeze 🧊";
for (const language of ["en", "ar"]) {
  for (const populated of [false, true]) {
    test(`${language}, products ${populated}: standalone Freeze uses exact message and shared recipient`, () => {
      lang = language;
      categories = populated ? [{ id: "one", products: [] }] : [];
      const tree = StorePage();
      const action = tree.props.children[1];
      expect(action.type).toBe("div");
      const link = action.props.children;
      expect(link.type).toBe("a");
      expect(link.props.children).toBe(language === "ar" ? "استخدام Freeze 🧊" : "Use Freeze 🧊");
      const url = new URL(link.props.href);
      expect(url.origin + url.pathname).toBe(`https://wa.me/${contactInfo.whatsappNumber}`);
      expect([...url.searchParams]).toEqual([["text", message]]);
      expect(link.props.target).toBe("_blank");
      expect(link.props.rel).toBe("noreferrer");
      expect(link.props.onClick).toBeUndefined();
      expect(link.props.price).toBeUndefined();
      expect(visit(action).some(node => node.type === "article")).toBe(false);
      expect(categories.length).toBe(populated ? 1 : 0);
    });
  }
}
test("Freeze is outside category mapping and has no write handler or product attributes", () => {
  lang = "en"; categories = [{ id: "a" }, { id: "b" }];
  const tree = StorePage();
  expect(tree.props.children[2].props.children.map((node: any) => node.props.category.id)).toEqual(["a", "b"]);
  const action = tree.props.children[1].props.children;
  expect(Object.keys(action.props).sort()).toEqual(["children", "className", "href", "rel", "target"]);
});
test("homepage uses the exact static marketing string and preserves surrounding metrics", () => {
  const home = source("src/routes/index.tsx");
  expect(home).toContain('{ value: "99+", label: t("home.stats.matches") }');
  expect(home).not.toContain("value: 64");
  expect(home).toContain('value: players?.length ?? 0');
  expect(home).toContain('{ value: 15, label: t("home.stats.metrics") }');
  expect(home).toContain("{s.value}");
  expect(home).toContain('dir={s.value === "99+" ? "ltr" : undefined}');
});
test("October remains unsupported", () => {
  expect(MONTHS).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
});
test("README describes current feeds, rewards and manual Freeze requests", () => {
  const readme = source("README.md");
  for (const text of ["Airtable is the source of truth", "15-minute hard expiry", "manual administrator review", "free match or 8 points", "or 70 points", "1.5 points", "0.25 points", "October is not supported yet"]) expect(readme).toContain(text);
  for (const text of ["Do NOT connect a database yet", "For now, leave the store empty", "immediately following match", "use structured mock/sample data"]) expect(readme).not.toContain(text);
  expect(readme).toContain("bun install --frozen-lockfile");
  expect(readme).toContain("bun test --isolate --timeout 15000");
});
