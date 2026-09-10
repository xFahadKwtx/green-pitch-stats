import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise current components without importing their server loaders or changing exports.
const require = createRequire(import.meta.url);
let state: string;
let effects: Array<() => void>;
let context: unknown;
let sandbox: Record<string, unknown>;
let i18n: ReturnType<typeof load>;
let saved: string | null;
let failure: string;
let logs: unknown[];
const source = (path: string) => readFileSync(path, "utf8");
function load(path: string, extra = "") {
  const module = { exports: {} as Record<string, any> };
  const code = ts.transpileModule(source(path) + extra, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(code, { ...sandbox, module, exports: module.exports, require: (name: string) => {
    if (name === "react") return { ...React,
      useState: () => [state, (value: string) => { state = value; }],
      useEffect: (effect: () => void) => effects.push(effect),
      useMemo: (factory: () => unknown) => factory(),
      useCallback: (callback: unknown) => callback,
      useContext: () => context,
    };
    if (name.startsWith("react/")) return require(name);
    if (name === "@/lib/i18n") return i18n;
    if (name === "@tanstack/react-router") return {
      createRootRouteWithContext: () => (options: unknown) => options,
      createFileRoute: () => (options: unknown) => options,
      useRouter: () => ({ invalidate() {} }),
      Link: ({ children }: { children: React.ReactNode }) => React.createElement("a", { href: "/" }, children),
    };
    if (name.endsWith("public-error")) return { createPublicError: () => new Error("Safe public error") };
    if (name.endsWith("lovable-error-reporting")) return { reportLovableError: (...args: unknown[]) => logs.push(args) };
    return { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") };
  } });
  return module.exports;
}
function fallback() {
  effects = [];
  i18n.useFallbackTranslation();
  effects.forEach(effect => effect());
  return i18n.useFallbackTranslation();
}
function provider(lang: string) {
  state = lang; effects = [];
  context = i18n.I18nProvider({ children: null }).props.value;
  effects[1]();
}
beforeEach(() => {
  state = "en"; saved = null; failure = ""; effects = []; logs = []; context = null;
  sandbox = {
    console: { error: (...args: unknown[]) => logs.push(args) },
    document: { documentElement: { setAttribute() {} } },
    window: { get localStorage() {
      if (failure === "getter") throw new Error("PRIVATE_STORAGE_ERROR");
      return {
        getItem() { if (failure === "read") throw new Error("PRIVATE_STORAGE_ERROR"); return saved; },
        setItem() { throw new Error("PRIVATE_STORAGE_ERROR"); },
      };
    } },
  };
  i18n = load("src/lib/i18n.tsx");
});

for (const [lang, switchLabel, group, labels] of [
  ["en", "Switch language", "Last 5 results", ["Win", "Loss", "Draw"]],
  ["ar", "تغيير اللغة", "نتائج آخر خمس مباريات", ["فوز", "خسارة", "تعادل"]],
] as const) {
  test(`${lang}: translated switch label uses the existing translation system`, () => {
    provider(lang);
    expect((context as any).t("language.switch")).toBe(switchLabel);
    expect(source("src/components/site-header.tsx")).toContain('aria-label={t("language.switch")}');
  });
  test(`${lang}: asymmetric last-five sequence preserves visible order and translated descriptions`, () => {
    provider(lang);
    const profile = load("src/routes/players.$playerId.tsx", "\nexport { Last5Results };");
    const results = ["W", "L", null, "D", "W"];
    const tree = profile.Last5Results({ results });
    expect(tree.props.dir).toBe("ltr");
    expect(tree.props.role).toBe("group");
    expect(tree.props["aria-label"]).toBe(group);
    expect(tree.props.children.map((child: any) => child.props.children)).toEqual(["W", "L", "", "D", "W"]);
    expect(tree.props.children.map((child: any) => child.props["aria-label"])).toEqual([labels[0], labels[1], undefined, labels[2], labels[0]]);
    expect(tree.props.children[2].props.role).toBeUndefined();
    expect(results).toEqual(["W", "L", null, "D", "W"]);
    expect((context as any).dir).toBe(lang === "ar" ? "rtl" : "ltr");
    expect(renderToStaticMarkup(tree)).toContain('role="img"');
  });
  for (const component of ["NotFoundComponent", "ErrorComponent"]) {
    test(`${lang}: ${component} renders localized safe copy without a provider`, () => {
      saved = lang; fallback();
      const root = load("src/routes/__root.tsx", "\nexport { NotFoundComponent, ErrorComponent };");
      const tree = root[component]({ error: new Error("PRIVATE_UPSTREAM_STACK"), reset() {} });
      const html = renderToStaticMarkup(tree);
      expect(tree.props.lang).toBe(lang);
      expect(tree.props.dir).toBe(lang === "ar" ? "rtl" : "ltr");
      expect(html).toContain(lang === "ar" ? "العودة إلى الرئيسية" : "Go home");
      expect(html).toContain(lang === "ar"
        ? component === "ErrorComponent" ? "تعذّر تحميل هذه الصفحة" : "الصفحة غير موجودة"
        : component === "ErrorComponent" ? "This page didn&#x27;t load" : "Page not found");
      effects.forEach(effect => effect());
      expect(html + JSON.stringify(logs)).not.toContain("PRIVATE_");
      expect(root.Route.notFoundComponent).toBe(root.NotFoundComponent);
      expect(root.Route.errorComponent).toBe(root.ErrorComponent);
    });
  }
}
for (const mode of ["getter", "read", "missing", "invalid"]) {
  test(`${mode}: fallback rendering retains English safely`, () => {
    failure = mode; saved = mode === "invalid" ? "invalid" : null;
    expect(() => fallback()).not.toThrow();
    expect(fallback().lang).toBe("en");
  });
}
for (const lang of ["en", "ar"]) {
  test(`${lang}: session language wins over stale persistence after provider unmount`, () => {
    provider(lang); saved = lang === "ar" ? "en" : "ar"; context = null; state = "en";
    expect(fallback().lang).toBe(lang);
    failure = "getter";
    expect(fallback().lang).toBe(lang);
  });
}
test("fallback server/initial hydration render uses English without window", () => {
  delete sandbox.window; delete sandbox.document;
  i18n = load("src/lib/i18n.tsx");
  expect(i18n.useFallbackTranslation().lang).toBe("en");
  expect(() => fallback()).not.toThrow();
  expect(fallback().lang).toBe("en");
});
test("session switch is remembered even if an error prevents the next provider effect", () => {
  provider("en");
  (context as any).setLang("ar");
  context = null; state = "en"; failure = "getter";
  expect(fallback().lang).toBe("ar");
});
