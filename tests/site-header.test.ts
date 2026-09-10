/**
 * M10 component-state tests. Run in a separate process because hooks are mocked.
 * Real browser keyboard, inert, CSS and accessibility checks complement these
 * tests; this harness does not pretend to implement a browser focus algorithm.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const actualReact = await import("react");
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const savedFetch = globalThis.fetch;
let open = false;
let desktop = false;
let lang: "en" | "ar" = "en";
let refIndex = 0;
let effectIndex = 0;
let callback: any;
let tree: any;
let nodes: any[];
let refs: Array<{ current: any }> = [];
let effects: Array<{ deps: unknown[]; cleanup?: (() => void) | undefined }> = [];
let pending: Array<() => void> = [];
const listeners = new Set<() => void>();
const queries: string[] = [];
let doc: any;
let panel: any;
let trigger: any;
let brand: any;
let language: any;
let outside: any;
let panelLink: any;
let preventions = 0;

function element(name: string) {
  const node: any = {
    name,
    contains: (target: any) => target === node,
    focus: (options: unknown) => { node.focusOptions = options; doc.activeElement = node; },
  };
  return node;
}
const media = {
  get matches() { return desktop; },
  addEventListener: (type: string, listener: () => void) => {
    expect(type).toBe("change"); listeners.add(listener);
  },
  removeEventListener: (type: string, listener: () => void) => {
    expect(type).toBe("change"); listeners.delete(listener);
  },
};
mock.module("react", () => ({
  ...actualReact,
  useState: () => [open, (value: boolean | ((v: boolean) => boolean)) => {
    open = typeof value === "function" ? value(open) : value;
  }],
  useId: () => ":m10-panel:",
  useRef: () => refs[refIndex++] ?? (refs[refIndex - 1] = { current: null }),
  useCallback: (fn: any) => callback ?? (callback = fn),
  useEffect: (run: () => (() => void) | void, deps: unknown[]) => {
    const i = effectIndex++;
    const prior = effects[i];
    if (!prior || deps.some((value, j) => value !== prior.deps[j])) {
      pending.push(() => {
        prior?.cleanup?.();
        effects[i] = { deps, cleanup: run() || undefined };
      });
    }
  },
}));
mock.module("@tanstack/react-router", () => ({ Link: "a" }));
mock.module("../src/lib/i18n", () => ({
  useI18n: () => ({
    lang,
    toggle: () => { lang = lang === "en" ? "ar" : "en"; },
    t: (key: string) => {
      if (key === "language.switch") return lang === "en" ? "Switch language" : "تغيير اللغة";
      if (key === "menu") return lang === "en" ? "Menu" : "القائمة";
      if (key === "close") return lang === "en" ? "Close" : "إغلاق";
      return key;
    },
  }),
}));
const { SiteHeader } = await import("../src/components/site-header");

function visit(node: any): void {
  if (Array.isArray(node)) { node.forEach(visit); return; }
  if (!node || typeof node !== "object" || !node.props) return;
  nodes.push(node);
  visit(node.props.children);
}
function render() {
  refIndex = 0; effectIndex = 0; pending = []; nodes = [];
  tree = SiteHeader(); visit(tree);
  const panelNode = nodes.find(n => n.props.id === ":m10-panel:");
  const triggerNode = nodes.find(n => n.props["aria-expanded"] !== undefined);
  const brandNode = nodes.find(n => n.type === "a");
  panelNode.props.ref.current = panel;
  triggerNode.props.ref.current = trigger;
  brandNode.props.ref.current = brand;
  pending.forEach(run => run());
  return { panel: panelNode, trigger: triggerNode, brand: brandNode };
}
function mobileLinks() {
  const found: any[] = [];
  function walk(n: any) {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n?.props) return;
    if (n.type === "a") found.push(n);
    walk(n.props.children);
  }
  walk(nodes.find(n => n.props.id === ":m10-panel:"));
  return found;
}
function openMenu() {
  doc.activeElement = trigger;
  render().trigger.props.onClick();
  return render();
}
function resize(isDesktop: boolean) {
  desktop = isDesktop;
  for (const listener of [...listeners]) listener();
  return render();
}
function escape(key = "Escape") {
  tree.props.onKeyDown({ key, preventDefault: () => { preventions++; } });
  return render();
}
function blurTo(target: any) {
  doc.activeElement = target ?? doc.body;
  tree.props.onBlur({
    currentTarget: { contains: (node: any) => [brand, trigger, language, panel, panelLink].includes(node) },
    relatedTarget: target,
  });
  return render();
}
beforeEach(() => {
  open = false; desktop = false; lang = "en"; callback = undefined;
  refs = []; effects = []; pending = []; listeners.clear(); queries.length = 0; preventions = 0;
  doc = { body: { style: { overflow: "" } }, activeElement: null };
  trigger = element("trigger"); brand = element("brand"); panel = element("panel");
  language = element("language"); outside = element("outside"); panelLink = element("panel-link");
  panel.contains = (target: any) => target === panel || target === panelLink;
  doc.activeElement = doc.body;
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: (query: string) => { queries.push(query); return media; },
  } });
  globalThis.fetch = (() => { throw new Error("Network forbidden in M10 tests"); }) as typeof fetch;
  render();
});
afterEach(() => {
  effects.forEach(effect => effect.cleanup?.());
  expect(listeners.size).toBe(0);
});
afterAll(() => {
  if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
  if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else Reflect.deleteProperty(globalThis, "document");
  globalThis.fetch = savedFetch;
});

describe("closed/open disclosure semantics", () => {
  test("real React/router SSR emits an inert panel associated with its trigger", async () => {
    // A fresh process avoids this file's hook mocks and needs no browser or API.
    const script = `
      import { createElement as h } from "react";
      import { renderToReadableStream } from "react-dom/server";
      import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
      import { SiteHeader } from "./src/components/site-header";
      import { I18nProvider } from "./src/lib/i18n";
      globalThis.fetch = () => { throw new Error("Network forbidden"); };
      const root = createRootRoute({ component: () => h(I18nProvider, null, h(SiteHeader)) });
      const index = createRoute({ getParentRoute: () => root, path: "/" });
      const router = createRouter({ routeTree: root.addChildren([index]), history: createMemoryHistory({ initialEntries: ["/"] }), isServer: true });
      await router.load();
      const stream = await renderToReadableStream(h(RouterProvider, { router }));
      console.log(await new Response(stream).text());
    `;
    const processResult = Bun.spawnSync([process.execPath, "-e", script], { cwd: process.cwd() });
    expect(processResult.exitCode).toBe(0);
    const html = processResult.stdout.toString();
    const id = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}" inert=""`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Menu"');
    expect(html).not.toContain('aria-modal="true"');
  });
  test("closed panel is inert but retains all nine links", () => {
    const { panel, trigger } = render();
    expect(panel.props.inert).toBe(true);
    expect(trigger.props["aria-expanded"]).toBe(false);
    expect(mobileLinks()).toHaveLength(9);
    expect(panel.props.className).toContain("max-h-0");
  });
  test("stable panel association survives opening and closing", () => {
    const id = render().panel.props.id;
    expect(render().trigger.props["aria-controls"]).toBe(id);
    expect(openMenu().panel.props.id).toBe(id);
    render().trigger.props.onClick();
    expect(render().panel.props.id).toBe(id);
  });
  for (const locale of ["en", "ar"] as const) {
    test(`native trigger labels and expanded state: ${locale}`, () => {
      lang = locale;
      expect(render().trigger.type).toBe("button");
      expect(render().trigger.props.type).toBe("button");
      expect(render().trigger.props["aria-label"]).toBe(locale === "en" ? "Menu" : "القائمة");
      expect(openMenu().trigger.props["aria-label"]).toBe(locale === "en" ? "Close" : "إغلاق");
      expect(render().trigger.props["aria-expanded"]).toBe(true);
      expect(render().panel.props.inert).toBe(false);
    });
  }
  test("animation and short-screen scrolling are retained", () => {
    const { panel } = openMenu();
    expect(panel.props.className).toContain("transition-[max-height] duration-300");
    expect(panel.props.className).toContain("overflow-y-auto");
    expect(panel.props.className).toContain("max-h-[calc(100dvh-4rem)]");
    expect(panel.props.className).toContain("sm:max-h-[calc(100dvh-5rem)]");
    expect(panel.props.style.paddingBottom).toBe("env(safe-area-inset-bottom)");
  });
  test("language switch keeps existing label and native button behavior", () => {
    openMenu();
    const button = nodes.find(n => n.props["aria-label"] === "Switch language");
    expect(button.type).toBe("button");
    expect(button.props.type).toBe("button");
    button.props.onClick(); render();
    expect(lang).toBe("ar");
    expect(open).toBe(true);
    expect(doc.body.style.overflow).toBe("hidden");
  });
  test("no modal semantics or keyboard trap are introduced", () => {
    openMenu();
    expect(nodes.some(n => n.props.role === "dialog" || n.props["aria-modal"])).toBe(false);
    escape("Tab"); expect(open).toBe(true); expect(preventions).toBe(0);
    escape("ArrowDown"); expect(open).toBe(true); expect(preventions).toBe(0);
  });
});

describe("dismissal and focus ownership", () => {
  for (const from of ["panel-link", "trigger", "language"] as const) {
    test(`Escape from ${from} closes, unlocks and restores visible trigger`, () => {
      openMenu(); doc.activeElement = from === "panel-link" ? panelLink : from === "language" ? language : trigger;
      const result = escape();
      expect(open).toBe(false); expect(result.panel.props.inert).toBe(true);
      expect(doc.body.style.overflow).toBe("");
      expect(doc.activeElement).toBe(trigger);
      expect(trigger.focusOptions).toEqual({ preventScroll: true });
      expect(preventions).toBe(1);
    });
  }
  test("Escape while closed leaves other keyboard behavior alone", () => {
    doc.activeElement = outside; escape();
    expect(preventions).toBe(0); expect(doc.activeElement).toBe(outside);
  });
  test("trigger toggle closes without losing its focus", () => {
    openMenu(); render().trigger.props.onClick(); render();
    expect(open).toBe(false); expect(doc.activeElement).toBe(trigger); expect(doc.body.style.overflow).toBe("");
  });
  for (const to of ["/", "/upcoming-games", "/players", "/compare", "/leaderboard", "/records", "/store", "/rewards", "/contact"]) {
    test(`navigation ${to} moves focus out before collapse`, () => {
      openMenu(); doc.activeElement = panelLink;
      mobileLinks().find(n => n.props.to === to).props.onClick();
      expect(doc.activeElement).toBe(trigger);
      expect(render().panel.props.inert).toBe(true);
      expect(doc.body.style.overflow).toBe("");
    });
  }
  test("navigation respects focus already moved to its destination", () => {
    openMenu(); doc.activeElement = outside;
    mobileLinks()[2].props.onClick(); render();
    expect(doc.activeElement).toBe(outside); expect(open).toBe(false);
  });
  test("logo navigation closes while retaining visible logo focus", () => {
    openMenu(); doc.activeElement = brand; render().brand.props.onClick(); render();
    expect(open).toBe(false); expect(doc.activeElement).toBe(brand); expect(doc.body.style.overflow).toBe("");
  });
  test("focus leaving the header closes without stealing destination focus", () => {
    openMenu(); blurTo(outside);
    expect(open).toBe(false); expect(doc.activeElement).toBe(outside); expect(doc.body.style.overflow).toBe("");
  });
  test("null focus destination closes without creating a focus loop", () => {
    openMenu(); blurTo(null);
    expect(open).toBe(false); expect(doc.activeElement).toBe(doc.body); expect(doc.body.style.overflow).toBe("");
  });
  test("focus moving within the header does not close", () => {
    openMenu();
    for (const node of [panelLink, trigger, language, brand]) {
      blurTo(node); expect(open).toBe(true); expect(doc.activeElement).toBe(node);
    }
  });
});

describe("responsive and scroll lifecycle", () => {
  for (const from of ["panel-link", "trigger", "outside"] as const) {
    test(`desktop crossing with focus at ${from} clears state safely`, () => {
      openMenu(); doc.activeElement = from === "panel-link" ? panelLink : from === "trigger" ? trigger : outside;
      resize(true);
      expect(open).toBe(false); expect(doc.body.style.overflow).toBe("");
      expect(doc.activeElement).toBe(from === "outside" ? outside : brand);
      expect(render().panel.props.inert).toBe(true);
      resize(false); expect(open).toBe(false); expect(doc.body.style.overflow).toBe("");
    });
  }
  test("closed resize does not move focus or acquire a scroll lock", () => {
    doc.activeElement = outside; resize(true); resize(false);
    expect(doc.activeElement).toBe(outside); expect(open).toBe(false); expect(doc.body.style.overflow).toBe("");
  });
  test("Escape at a desktop crossing never targets the hidden trigger", () => {
    openMenu(); desktop = true; doc.activeElement = panelLink; escape();
    expect(doc.activeElement).toBe(brand); expect(open).toBe(false);
  });
  test("CSS and resize listener use coordinated xl/80rem boundary", () => {
    openMenu(); resize(true);
    expect(queries.every(query => query === "(min-width: 80rem)")).toBe(true);
    expect(render().trigger.props.className).toContain("xl:hidden");
    expect(render().panel.props.className).toContain("xl:hidden");
    expect(nodes.find(n => n.type === "nav").props.className).toContain("xl:flex");
    expect(nodes.some(n => /(^| )lg:/.test(n.props.className ?? ""))).toBe(false);
  });
  test("only brand text can shrink; controls and logo retain their size", () => {
    const { brand } = render();
    expect(brand.props.className).toContain("min-w-0");
    expect(brand.props.className).not.toContain("shrink-0");
    expect(nodes.find(n => n.type === "img").props.className).toContain("shrink-0");
    expect(nodes.filter(n => n.type === "span" && n.props.className?.includes("truncate"))).toHaveLength(2);
    expect(nodes.some(n => n.type === "div" && n.props.className?.includes("flex shrink-0 items-center gap-2"))).toBe(true);
  });
  for (const previous of ["", "auto", "scroll", "hidden"]) {
    test(`restores prior body overflow ${JSON.stringify(previous)}`, () => {
      doc.body.style.overflow = previous; render();
      expect(doc.body.style.overflow).toBe(previous);
      openMenu(); expect(doc.body.style.overflow).toBe("hidden");
      escape(); expect(doc.body.style.overflow).toBe(previous);
    });
  }
  test("unmount releases scroll lock and removes resize listener", () => {
    doc.body.style.overflow = "auto"; openMenu();
    expect(listeners.size).toBe(1);
    effects.forEach(effect => effect.cleanup?.()); effects = [];
    expect(listeners.size).toBe(0); expect(doc.body.style.overflow).toBe("auto");
  });
  test("both navigation versions retain identical original contents and order", () => {
    const expected = ["/", "/upcoming-games", "/players", "/compare", "/leaderboard", "/records", "/store", "/rewards", "/contact"];
    expect(mobileLinks().map(n => n.props.to)).toEqual(expected);
    expect(nodes.filter(n => n.type === "a").slice(1, 10).map(n => n.props.to)).toEqual(expected);
    expect(mobileLinks().map(n => n.props.children)).toEqual([
      "nav.home", "nav.games", "nav.players", "nav.compare", "nav.leaderboard",
      "nav.records", "nav.store", "nav.rewards", "nav.contact",
    ]);
  });
});
