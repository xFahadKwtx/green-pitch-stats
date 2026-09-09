/** M8 only. Run separately: module mocks and fake browser hooks are process-local. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Match } from "../src/data/types";
import type { AirtableRecord } from "../src/lib/airtable.server";
import {
  compareBookings, eligibleBookings, isBookingEligible, kuwaitWeek,
  nextBookingTransition, normalizeBooking, parseBookingDate, parseBookingTime,
} from "../src/lib/upcoming-games";
import { dayName, longDate, prettyTime, registrationLink } from "../src/lib/format";
import { __testing, FEED_TTL_SECONDS, AirtableRateLimitError } from "../src/lib/public-feed-cache.server";
import { PUBLIC_ERROR_MESSAGE } from "../src/lib/public-error";

const actualReact = await import("react");
const actualAirtable = await import("../src/lib/airtable.server");
const realFetch = globalThis.fetch;
const realNow = Date.now;
let now = Date.parse("2026-09-13T20:00:00+03:00");
let rows: AirtableRecord[] = [];
let queryData: Match[] = [];
let reads: string[] = [];
let upstreamError: Error | null = null;
let lang: "en" | "ar" = "en";
let effects: Array<() => (() => void) | void> = [];
let captureEffects = false;
let updates = 0;
let networkCalls = 0;
const blockedFetch = (() => { networkCalls++; throw new Error("Real network forbidden in M8 tests"); }) as typeof fetch;
globalThis.fetch = blockedFetch;
Date.now = () => now;
afterAll(() => { globalThis.fetch = realFetch; Date.now = realNow; });

mock.module("../src/lib/airtable.server", () => ({
  ...actualAirtable,
  listAirtableRecords: async (table: string) => {
    reads.push(table);
    expect(table).toBe(actualAirtable.AIRTABLE_TABLES.upcomingGames);
    if (upstreamError) throw upstreamError;
    return rows;
  },
}));
// Execute the real handler without requiring a network transport/server request context.
mock.module("@tanstack/react-start", () => ({ createServerFn: () => ({ handler: (run: unknown) => run }) }));
mock.module("@tanstack/react-query", () => ({ useSuspenseQuery: () => ({ data: queryData }) }));
mock.module("../src/lib/upcoming-games-query", () => ({ upcomingGamesQueryOptions: {} }));
mock.module("../src/lib/i18n", () => ({ useI18n: () => ({ lang, t: (key: string) => key }) }));
mock.module("../src/components/ui-kit", () => ({
  PageShell: ({ children }: { children: ReactNode }) => createElement("main", null, children),
  PageHeader: () => createElement("header"),
}));
// Capture the actual route's effect and event callbacks, without adding a DOM dependency.
mock.module("react", () => ({
  ...actualReact,
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => { updates++; }],
  useEffect: (effect: () => (() => void) | void) => { if (captureEffects) effects.push(effect); },
}));

const { fetchUpcomingGamesFromAirtable } = await import("../src/lib/upcoming-games.server");
const { getUpcomingGames } = await import("../src/lib/upcoming-games.functions");
const { Route } = await import("../src/routes/upcoming-games");
const Page = Route.options.component as () => any;

beforeEach(() => {
  now = Date.parse("2026-09-13T20:00:00+03:00");
  rows = []; queryData = []; reads = []; lang = "en"; effects = [];
  captureEffects = false; updates = 0; networkCalls = 0; upstreamError = null;
});

function booking(date = "2026-09-13", time = "10:00 PM", id = "game"): Match {
  return { id, date, time, location: "Wahet Mishref", locationAr: "واحة مشرف" };
}
function row(date: unknown = "2026-09-13", time: unknown = "10:00 PM", visible: unknown = true, id = "game"): AirtableRecord {
  return { id, fields: { Date: date, time, "Show On Website": visible,
    "Location EN": "Wahet Mishref", "Location AR": "واحة مشرف" } };
}
function html() { return renderToStaticMarkup(createElement(Page)); }
function links(markup: string): URL[] {
  return [...markup.matchAll(/href="([^"]+)"/g)].map(m => new URL(m[1]!.replaceAll("&amp;", "&")));
}
function nodes(tree: any, predicate: (node: any) => boolean): any[] {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(n => nodes(n, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}

describe("real calendar dates", () => {
  for (const date of ["2026-09-09", "2026-02-28", "2028-02-29", "2000-02-29", "2026-12-31", "2027-01-01", "0001-01-01", "0099-12-31", "9999-12-31", " 2026-09-09 "]) {
    test(`accept ${date}`, () => {
      const parsed = parseBookingDate(date);
      expect(parsed).not.toBeNull();
      expect(new Date(parsed!).toISOString().slice(0, 10)).toBe(date.trim());
    });
  }
  for (const date of ["2026-02-29", "2026-02-30", "1900-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-09-00", "2026-09-32", "0000-01-01", "2026-9-09", "09/09/2026", "not-a-date", "", "   ", "2026-09-09garbage", "2026-09-09T22:30:00Z", "2026-09-09T22:30:00+03:00", "2026-09-09\nextra", null, undefined, 20260909, true, ["2026-09-09"]]) {
    test(`reject ${JSON.stringify(date)}`, () => { expect(parseBookingDate(date)).toBeNull(); });
  }
});

const times = [
  ["21:00", 1260, "9:00 PM"], ["09:00", 540, "9:00 AM"], ["9:00 PM", 1260, "9:00 PM"],
  ["10:30 PM", 1350, "10:30 PM"], ["12:00 AM", 0, "12:00 AM"], ["12:00 PM", 720, "12:00 PM"],
  ["1:05 AM", 65, "1:05 AM"], ["11:59 PM", 1439, "11:59 PM"], ["22:30", 1350, "10:30 PM"],
  ["00:00", 0, "12:00 AM"], ["12:00", 720, "12:00 PM"], ["01:05", 65, "1:05 AM"],
  ["9:00", 540, "9:00 AM"], [" 9:00 pm ", 1260, "9:00 PM"], ["9:00PM", 1260, "9:00 PM"],
  ["9:00  PM", 1260, "9:00 PM"], ["23:59", 1439, "11:59 PM"],
] as const;
const invalidTimes = ["24:00", "25:90", "12:60", "abc", "", "   ", "9:NaN", "9:00 XM", "13:00 PM", "0:30 AM", "00:00 AM", "9", "9:0", "9:00:00", "9.00 PM", "9:00 P.M.", "9:00\nPM", "٩:٠٠ م", "-1:00", "Infinity:00", "9:00 PM junk", null, undefined, 2100, true, ["21:00"]];

describe("time parsing and bilingual public display", () => {
  for (const [input, minutes, expected] of times) {
    test(`${input} parses as ${minutes} minutes`, () => {
      expect(parseBookingTime(input)).toBe(minutes);
      const normalized = normalizeBooking(booking("2026-09-14", input))!;
      expect(normalized.time).toMatch(/^\d{2}:\d{2}$/);
      expect(parseBookingTime(normalized.time)).toBe(minutes);
    });
    for (const language of ["en", "ar"] as const) {
      test(`${language}: actual card and WhatsApp display ${input} as ${expected}`, async () => {
        lang = language;
        rows = [row("2026-09-14", input)];
        queryData = await fetchUpcomingGamesFromAirtable();
        const markup = html();
        const urls = links(markup);
        expect(urls.length).toBe(1);
        const game = queryData[0]!;
        const message = urls[0]!.searchParams.get("text")!;
        const lines = message.split("\n");
        expect(lines[2]).toBe(dayName(game.date, language));
        expect(lines[3]).toBe(longDate(game.date, language));
        expect(lines[4]).toBe(expected);
        expect(lines[5]).toBe(language === "ar" ? game.locationAr : game.location);
        expect(markup).toContain(`>${expected}</dd>`);
        expect(markup).toContain(dayName(game.date, language));
        expect(markup).toContain(longDate(game.date, language));
        expect(markup).toContain(lines[5]!);
        expect(prettyTime(game.time, language)).toBe(expected);
        expect(new URL(registrationLink(game, "123", language)).searchParams.get("text")).toBe(message);
        expect(message.match(/\d{1,2}:\d{2}(?: AM| PM)?/g)).toEqual([expected]);
        expect(markup).not.toContain("Invalid Date");
        expect(markup).not.toContain("NaN");
      });
    }
  }
  for (const input of invalidTimes) {
    test(`reject malformed time ${JSON.stringify(input)} without card/link`, async () => {
      expect(parseBookingTime(input)).toBeNull();
      rows = [row("2026-09-13", input)];
      if (input === undefined) delete rows[0]!.fields["time"];
      queryData = await fetchUpcomingGamesFromAirtable();
      expect(queryData).toEqual([]);
      expect(links(html())).toEqual([]);
      expect(html()).not.toContain("<article");
    });
  }
});

describe("Airtable mapping", () => {
  for (const visibility of [true, false, null, undefined, "", "true", "false", "yes", 1, 0, -1, [], [true], {}, NaN]) {
    test(`strict visibility ${JSON.stringify(visibility)}`, async () => {
      const record = row();
      if (visibility === undefined) delete record.fields["Show On Website"];
      else record.fields["Show On Website"] = visibility;
      rows = [record];
      const before = JSON.stringify(rows);
      queryData = await fetchUpcomingGamesFromAirtable();
      expect(queryData.length).toBe(visibility === true ? 1 : 0);
      expect(links(html()).length).toBe(visibility === true ? 1 : 0);
      expect(JSON.stringify(rows)).toBe(before);
      expect(reads).toEqual([actualAirtable.AIRTABLE_TABLES.upcomingGames]);
    });
  }
  test("invalid rows are skipped individually; unrelated fields never determine the day/status/location", async () => {
    rows = [row("2026-02-30"), row("not-a-date"), row(" "), row("2026-09-09garbage"),
      row("2026-09-13", ""), row("2026-09-13", "24:00"), row("2026-09-13", "22:00", "true"),
      { ...row("2026-09-13", "22:00", true, "valid"), fields: { ...row().fields, Day: "Friday", Status: "Closed", "Where to Buy": "ignored" } }];
    queryData = await fetchUpcomingGamesFromAirtable();
    expect(queryData).toEqual([booking("2026-09-13", "22:00", "valid")]);
    expect(html()).toContain("Sunday");
    expect(html()).not.toContain("Friday");
    expect(links(html()).length).toBe(1);
  });
  test("valid past/future dates remain in the cache loader for later eligibility", async () => {
    rows = [row("2030-01-01", "22:00", true, "future"), row("2026-09-12", "22:00", true, "past"),
      row("2026-09-20", "22:00", true, "next-week"), row("2026-09-13", "22:00", true, "current")];
    const result = await fetchUpcomingGamesFromAirtable();
    expect(result.map(g => g.id)).toEqual(["past", "current", "next-week", "future"]);
    expect(eligibleBookings(result, now).map(g => g.id)).toEqual(["current"]);
  });
  test("same-date mixed formats and following-day midnight sort chronologically", async () => {
    rows = [row("2026-09-14", "12:00 AM", true, "next-midnight"), row("2026-09-13", "11:30 PM", true, "late"),
      row("2026-09-13", "22:00", true, "ten"), row("2026-09-13", "9:00 PM", true, "nine"),
      row("2026-09-13", "12:00 AM", true, "first-midnight")];
    const result = await fetchUpcomingGamesFromAirtable();
    expect(result.map(g => g.id)).toEqual(["first-midnight", "nine", "ten", "late", "next-midnight"]);
    expect(eligibleBookings(result, now).map(g => g.id)).toEqual(["nine", "ten", "late", "next-midnight"]);
    expect(compareBookings(booking("2026-09-13", "22:00"), booking("2026-09-13", "10:00 PM"))).toBe(0);
  });
  test("Arabic missing location remains blank, without an invented English fallback", async () => {
    rows = [row()]; delete rows[0]!.fields["Location AR"];
    queryData = await fetchUpcomingGamesFromAirtable(); lang = "ar";
    expect(links(html())[0]!.searchParams.get("text")!.split("\n").at(-1)).toBe("");
    expect(html()).not.toContain("Wahet Mishref");
  });
});

describe("Kuwait current week and exact start cutoff", () => {
  for (const [date, time, expected] of [
    ["2026-09-12", "23:59", false], ["2026-09-13", "09:00", false],
    ["2026-09-13", "22:00", true], ["2026-09-14", "09:00", true],
    ["2026-09-16", "22:00", true], ["2026-09-19", "23:59", true],
    ["2026-09-20", "00:00", false], ["2030-01-01", "22:00", false],
  ] as const) {
    test(`${date} ${time}: eligible=${expected}`, () => {
      expect(isBookingEligible(booking(date, time), now)).toBe(expected);
      queryData = [booking(date, time)]; expect(links(html()).length).toBe(expected ? 1 : 0);
    });
  }
  for (const delta of [-60_000, -1000, -1, 0, 1, 1000, 60_000]) {
    test(`start offset ${delta}ms`, () => {
      now = Date.parse("2026-09-13T22:00:00+03:00") + delta;
      expect(isBookingEligible(booking(), now)).toBe(delta < 0);
      queryData = [booking()]; expect(links(html()).length).toBe(delta < 0 ? 1 : 0);
    });
  }
  for (const [instant, start, end] of [
    ["2026-09-12T23:59:59.999+03:00", "2026-09-06T00:00:00+03:00", "2026-09-13T00:00:00+03:00"],
    ["2026-09-13T00:00:00+03:00", "2026-09-13T00:00:00+03:00", "2026-09-20T00:00:00+03:00"],
    ["2026-09-19T23:59:59.999+03:00", "2026-09-13T00:00:00+03:00", "2026-09-20T00:00:00+03:00"],
    ["2026-09-30T23:59:59.999+03:00", "2026-09-27T00:00:00+03:00", "2026-10-04T00:00:00+03:00"],
    ["2026-10-01T00:00:00+03:00", "2026-09-27T00:00:00+03:00", "2026-10-04T00:00:00+03:00"],
    ["2026-12-31T23:59:59.999+03:00", "2026-12-27T00:00:00+03:00", "2027-01-03T00:00:00+03:00"],
    ["2027-01-01T00:00:00+03:00", "2026-12-27T00:00:00+03:00", "2027-01-03T00:00:00+03:00"],
    ["2027-01-03T00:00:00+03:00", "2027-01-03T00:00:00+03:00", "2027-01-10T00:00:00+03:00"],
  ]) {
    test(`week boundaries at ${instant}`, () => {
      expect(kuwaitWeek(Date.parse(instant!))).toEqual({ start: Date.parse(start!), end: Date.parse(end!) });
    });
  }
  test("following-day midnight becomes ineligible exactly at Kuwait midnight", () => {
    const game = booking("2026-09-14", "12:00 AM");
    const midnight = Date.parse("2026-09-14T00:00:00+03:00");
    expect(isBookingEligible(game, midnight - 1)).toBe(true);
    expect(isBookingEligible(game, midnight)).toBe(false);
    expect(isBookingEligible(game, midnight + 1)).toBe(false);
  });
  test("malformed older cached values are excluded without mutating the cache", () => {
    const data = [booking("2026-02-30"), booking("2026-09-13", ""), booking("2026-09-13", "abc"), booking()];
    const before = JSON.stringify(data); data.forEach(Object.freeze); Object.freeze(data);
    expect(eligibleBookings(data, now)).toEqual([booking("2026-09-13", "22:00")]);
    expect(JSON.stringify(data)).toBe(before);
  });
  for (const tz of ["UTC", "Asia/Kuwait", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Kiritimati"]) {
    test(`independent runtime timezone ${tz}`, () => {
      const script = `import { isBookingEligible, kuwaitWeek } from './src/lib/upcoming-games';
        import { dayName, longDate } from './src/lib/format';
        const g=${JSON.stringify(booking("2026-09-13", "00:01"))};
        const before=Date.parse('2026-09-12T23:59:59.999+03:00');
        const sunday=Date.parse('2026-09-13T00:00:00+03:00');
        console.log(JSON.stringify([isBookingEligible(g,before),isBookingEligible(g,sunday),
          isBookingEligible(g,sunday+60000),kuwaitWeek(sunday),dayName(g.date,'en'),longDate(g.date,'en')]));`;
      const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env, TZ: tz } });
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout.toString())).toEqual([false, true, false,
        { start: Date.parse("2026-09-13T00:00:00+03:00"), end: Date.parse("2026-09-20T00:00:00+03:00") },
        "Sunday", "13 September 2026"]);
    });
  }
});

/** The real H2 and M1 implementations run; only their network transport is synthetic. */
async function coordinator(status: string, payload: Match[], run: (calls: Array<{ operation: string; body: any }>) => Promise<void>) {
  const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const saved = keys.map(key => process.env[key]);
  process.env.SUPABASE_URL = "https://m8-coordinator.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_only";
  __testing.setMode("production"); __testing.setMonotonic(() => now); __testing.setSleep(async () => {});
  const calls: Array<{ operation: string; body: any }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "m8-coordinator.test") throw new Error("Unmocked network forbidden");
    const operation = url.pathname.split("/").at(-1)!;
    calls.push({ operation, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (operation === "h2_get_or_claim") return Response.json(status === "fresh"
      ? { status, fresh_for_ms: 900_000, payload }
      : status === "claimed" ? { status, lease_token: "m8-lease", refresh_deadline_ms: 45_000 } : { status });
    if (operation === "airtable_public_cache") return Response.json([{ payload,
      refresh_started_at: new Date(now - 60_000).toISOString(), fresh_until: new Date(now + 840_000).toISOString(),
    }], { headers: { date: new Date(now).toUTCString() } });
    if (operation === "h2_finish_refresh") return Response.json({ status: "published" });
    if (operation === "h2_fail_refresh") return Response.json({ status: "recorded", released: true });
    throw new Error("Unexpected coordinator operation: " + operation);
  }) as typeof fetch;
  try { await run(calls); expect(__testing.inFlightSize()).toBe(0); }
  finally {
    globalThis.fetch = blockedFetch; __testing.setMode(undefined); __testing.resetMonotonic(); __testing.resetSleep();
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
}

describe("actual server handler after unchanged H2", () => {
  test("fresh cache at 9:50, served before and exactly at 10PM, without Airtable refresh", async () => {
    const payload = [booking()]; const before = JSON.stringify(payload);
    await coordinator("fresh", payload, async calls => {
      now = Date.parse("2026-09-13T21:50:00+03:00"); expect((await getUpcomingGames()).length).toBe(1);
      now = Date.parse("2026-09-13T21:59:59.999+03:00"); expect((await getUpcomingGames()).length).toBe(1);
      now++; expect(await getUpcomingGames()).toEqual([]);
      expect(reads).toEqual([]);
      expect(calls.map(c => c.operation)).toEqual(["h2_get_or_claim", "h2_get_or_claim", "h2_get_or_claim"]);
      expect(JSON.stringify(payload)).toBe(before); expect(FEED_TTL_SECONDS).toBe(900);
    });
  });
  test("Sunday week rollover uses the same cached payload without an Airtable refresh", async () => {
    const payload = [booking("2026-09-19", "23:59", "sat"), booking("2026-09-20", "00:01", "sun")];
    await coordinator("fresh", payload, async calls => {
      now = Date.parse("2026-09-19T23:58:00+03:00"); expect((await getUpcomingGames()).map(g => g.id)).toEqual(["sat"]);
      now = Date.parse("2026-09-20T00:00:00+03:00"); expect((await getUpcomingGames()).map(g => g.id)).toEqual(["sun"]);
      expect(reads).toEqual([]); expect(calls.length).toBe(2);
    });
  });
  test("refresh publishes all validated dates but returns only currently eligible bookings", async () => {
    rows = [row("2026-09-13", "22:00", true, "current"), row("2026-09-20", "22:00", true, "next"), row("2026-02-30")];
    await coordinator("claimed", [], async calls => {
      expect((await getUpcomingGames()).map(g => g.id)).toEqual(["current"]);
      const published = calls.find(c => c.operation === "h2_finish_refresh")!;
      expect(published.body.p_payload.map((g: Match) => g.id)).toEqual(["current", "next"]);
      expect(reads.length).toBe(1);
    });
  });
  for (const status of ["busy", "backoff", "cooldown", "budget_exhausted", "disabled"]) {
    test(`still-fresh H2 ${status} fallback receives current-time eligibility`, async () => {
      await coordinator(status, [booking("2026-09-13", "19:00", "past"), booking(), booking("2026-09-20", "22:00", "next")], async () => {
        expect((await getUpcomingGames()).map(g => g.id)).toEqual(["game"]); expect(reads).toEqual([]);
      });
    });
  }
  test("typed 429 reaches H2 cleanup before M1 sanitization", async () => {
    upstreamError = new AirtableRateLimitError(120);
    const originalError = console.error; const logs: unknown[] = []; console.error = value => logs.push(value);
    try {
      await coordinator("claimed", [], async calls => {
        await expect(getUpcomingGames()).rejects.toThrow(PUBLIC_ERROR_MESSAGE);
        const cleanup = calls.find(c => c.operation === "h2_fail_refresh")!;
        expect(cleanup).toBeDefined(); expect(JSON.stringify(cleanup.body)).toContain("120");
        expect(logs.length).toBeGreaterThan(0);
      });
    } finally { console.error = originalError; }
  });
});

function fakeBrowser() {
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const win = new EventTarget(); const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = "visible";
  let serial = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  Object.assign(win, {
    setTimeout(callback: () => void, delay: number) { const id = ++serial; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  captureEffects = true; html(); captureEffects = false;
  expect(effects.length).toBe(1);
  const cleanup = effects[0]!();
  return {
    timers,
    advance(target: number) {
      let count = 0;
      while (true) {
        const pending = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!pending || pending[1].at > target) break;
        if (++count > 20) throw new Error("Unexpected timer loop");
        timers.delete(pending[0]); now = pending[1].at; pending[1].callback();
      }
      now = target;
    },
    focus() { win.dispatchEvent(new Event("focus")); },
    visibility(value: string) { doc.visibilityState = value; doc.dispatchEvent(new Event("visibilitychange")); },
    cleanup() { cleanup?.(); },
    restore() {
      cleanup?.();
      if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
      if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else Reflect.deleteProperty(globalThis, "document");
    },
  };
}

describe("actual open-page effect and registration callbacks", () => {
  test("one-shot timer removes a card exactly at start and schedules the next transition, with no network", () => {
    now = Date.parse("2026-09-13T21:59:00+03:00");
    queryData = [booking(), booking("2026-09-13", "23:00", "later")];
    const browser = fakeBrowser();
    try {
      expect(browser.timers.size).toBe(1); expect(links(html()).length).toBe(2);
      browser.advance(Date.parse("2026-09-13T21:59:59.999+03:00")); expect(links(html()).length).toBe(2);
      const previousUpdates = updates;
      browser.advance(now + 1); expect(updates).toBe(previousUpdates + 1); expect(links(html()).length).toBe(1);
      expect([...browser.timers.values()][0]!.at).toBe(Date.parse("2026-09-13T23:00:00+03:00"));
      browser.advance(Date.parse("2026-09-13T23:00:00+03:00")); expect(links(html())).toEqual([]);
      expect(browser.timers.size).toBe(1); expect(networkCalls).toBe(0); expect(reads).toEqual([]);
    } finally { browser.restore(); }
  });
  for (const event of ["focus", "visibility"] as const) {
    test(`suspended timer is corrected on ${event} return`, () => {
      queryData = [booking()]; const browser = fakeBrowser();
      try {
        const previous = updates;
        now = Date.parse("2026-09-13T22:01:00+03:00"); // No timer callbacks: simulate suspension.
        if (event === "focus") browser.focus(); else browser.visibility("visible");
        expect(updates).toBe(previous + 1); expect(links(html())).toEqual([]);
        expect(browser.timers.size).toBe(1); expect(networkCalls).toBe(0);
      } finally { browser.restore(); }
    });
  }
  test("hidden visibility changes do not reschedule; unmount removes timer and listeners", () => {
    queryData = [booking()]; const browser = fakeBrowser();
    try {
      const previous = updates; browser.visibility("hidden"); expect(updates).toBe(previous);
      browser.cleanup(); expect(browser.timers.size).toBe(0);
      browser.focus(); browser.visibility("visible"); expect(updates).toBe(previous);
    } finally { browser.restore(); }
  });
  test("week boundary updates open-page eligibility without refresh or polling", () => {
    now = Date.parse("2026-09-19T23:59:59.999+03:00");
    queryData = [booking("2026-09-20", "00:01", "next")];
    const browser = fakeBrowser();
    try {
      expect(links(html())).toEqual([]);
      expect([...browser.timers.values()][0]!.at).toBe(now + 1);
      const previous = updates; browser.advance(now + 1);
      expect(updates).toBe(previous + 1); expect(links(html()).length).toBe(1);
      expect(networkCalls).toBe(0); expect(reads).toEqual([]);
    } finally { browser.restore(); }
  });
  for (const event of ["onClick", "onAuxClick"]) {
    for (const delta of [-1, 0, 1, 60_000]) {
      test(`${event} ${delta}ms from start ${delta < 0 ? "allows" : "blocks"} registration`, () => {
        queryData = [booking()];
        const card = nodes(Page(), node => typeof node.type === "function" && node.props?.match)[0]!;
        const anchor = nodes(card.type(card.props), node => node.type === "a")[0]!;
        expect(anchor.props.href).toContain("https://wa.me/");
        now = Date.parse("2026-09-13T22:00:00+03:00") + delta;
        let prevented = false;
        anchor.props[event]({ preventDefault() { prevented = true; } });
        expect(prevented).toBe(delta >= 0); expect(updates).toBe(delta >= 0 ? 1 : 0);
        expect(links(html()).length).toBe(delta >= 0 ? 0 : 1); expect(networkCalls).toBe(0);
      });
    }
  }
  test("old invalid cached rows never create an active card or booking message", () => {
    queryData = [booking("not-a-date"), booking("2026-09-13", "abc"), booking("2026-09-13", "")];
    expect(nodes(Page(), node => !!node.props?.match)).toEqual([]);
    expect(links(html())).toEqual([]); expect(html()).not.toContain("<article");
    expect(html()).not.toContain("NaN"); expect(html()).not.toContain("Invalid Date");
  });
  test("next transition ignores malformed/past/next-week entries and defaults to Sunday", () => {
    expect(nextBookingTransition([booking("bad"), booking("2026-09-13", "19:00"), booking("2026-09-20")], now)).toBe(kuwaitWeek(now).end);
    expect(nextBookingTransition([booking("2026-09-13", "21:00"), booking()], now)).toBe(Date.parse("2026-09-13T21:00:00+03:00"));
  });
});
