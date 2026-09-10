/** Provider lifecycle tests; browser hydration is also checked locally with real React. */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const react = await import("react");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let language = "en";
let effects: Array<() => void> = [];
let attributes: Record<string, string> = {};
let reads = 0;
let writes: Array<[string, string]> = [];

mock.module("react", () => ({
  ...react,
  useState: () => [language, (value: string) => { language = value; }],
  useEffect: (effect: () => void) => { effects.push(effect); },
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
const { I18nProvider } = await import("../src/lib/i18n");

function render() {
  effects = [];
  return I18nProvider({ children: null }).props.value;
}
function mount() {
  render();
  const mountEffects = effects;
  for (const effect of mountEffects) effect();
  const value = render();
  effects[1]();
  return value;
}
function storage(saved: string | null, failure?: "getter" | "read" | "write") {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    get localStorage() {
      if (failure === "getter") throw new DOMException("Blocked", "SecurityError");
      return {
        getItem(key: string) {
          reads++;
          expect(key).toBe("maa-lang");
          if (failure === "read") throw new DOMException("Blocked", "SecurityError");
          return saved;
        },
        setItem(key: string, value: string) {
          if (failure === "write") throw new DOMException("Blocked", "SecurityError");
          writes.push([key, value]);
        },
      };
    },
  } });
}
beforeEach(() => {
  language = "en"; reads = 0; writes = []; attributes = {};
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { setAttribute(key: string, value: string) { attributes[key] = value; } },
  } });
  storage(null);
});
afterAll(() => {
  for (const [key, descriptor] of [["window", originalWindow], ["document", originalDocument]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

for (const failure of ["getter", "read"] as const) {
  test(`${failure} failure retains English without throwing`, () => {
    storage("ar", failure);
    expect(() => mount()).not.toThrow();
    expect(render().lang).toBe("en");
    expect(attributes).toEqual({ dir: "ltr", lang: "en" });
  });
  test(`switching after ${failure} failure still works`, () => {
    storage(null, failure);
    expect(() => mount().setLang("ar")).not.toThrow();
    expect(render().lang).toBe("ar");
    effects[1]();
    expect(attributes).toEqual({ dir: "rtl", lang: "ar" });
    expect(() => render().toggle()).not.toThrow();
    expect(render().lang).toBe("en");
  });
}
test("failed persistence does not prevent session switching", () => {
  storage("en", "write");
  expect(() => mount().setLang("ar")).not.toThrow();
  expect(render().lang).toBe("ar");
  expect(() => render().toggle()).not.toThrow();
  expect(render().lang).toBe("en");
});
for (const [saved, expected] of [[null, "en"], ["invalid", "en"], ["en", "en"], ["ar", "ar"]] as const) {
  test(`saved preference ${String(saved)} resolves to ${expected}`, () => {
    storage(saved);
    expect(mount().lang).toBe(expected);
    expect(reads).toBe(1);
    expect(writes).toEqual([]);
  });
}
test("working persistence keeps its key and value", () => {
  mount().setLang("ar");
  expect(writes).toEqual([["maa-lang", "ar"]]);
  expect(render().lang).toBe("ar");
});
test("server render phase needs no window or document", () => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  expect(() => render()).not.toThrow();
  expect(render().lang).toBe("en");
});
test("initial client render stays English before restoring Arabic in the effect", () => {
  storage("ar");
  expect(render().lang).toBe("en");
  expect(reads).toBe(0);
  expect(mount().lang).toBe("ar");
  expect(attributes).toEqual({ dir: "rtl", lang: "ar" });
});
