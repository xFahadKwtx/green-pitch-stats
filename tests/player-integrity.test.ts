/** M7: real loaders/H2/M1, with only network responses replaced by local fixtures. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { MonthKey, Player } from "../src/data/types";
import { AIRTABLE_TABLES, type AirtableRecord } from "../src/lib/airtable.server";
import { fetchPlayersFromAirtable } from "../src/lib/airtable-players.server";
import { __testing, getCachedPublicFeed } from "../src/lib/public-feed-cache.server";
import { withPublicFeedBoundary } from "../src/lib/public-error.server";
import { PUBLIC_ERROR_MESSAGE } from "../src/lib/public-error";
import { aggregateKeeper, aggregateOutfield } from "../src/lib/stats";

const A = "recAlpha12345678", B = "recBeta123456789", U = "recUnresolved1234";
/** Exactly the link field names present in the live Airtable base. */
const months: [MonthKey, string, string][] = [
  ["2026-06", AIRTABLE_TABLES.statsJune, "احصائيات اللاعب"],
  ["2026-07", AIRTABLE_TABLES.statsJuly, "Players DATABASE"],
  ["2026-08", AIRTABLE_TABLES.statsAugust, "Players DATABASE 2"],
  ["2026-09", AIRTABLE_TABLES.statsSeptember, "Players DATABASE 2"],
];

const full = {
  "Games played": 3, Goals: 2, Assists: 1, MVP: 2, POTM: true,
  "SHOTS ttl - SOT": "8 - 4", Passes: "9 - 7", Tackles: 6, Clearences: 3,
  "Successful Dribbles": 2, KeyPasses: 4, "Chances Created": 99,
  "GK saves": "8 - 6", "Highest Rating": 8.25, "Lowest Rating": 7.5,
};
const expectedMonth = {
  gamesPlayed: 3, goals: 2, assists: 1, mvpAwards: 2, shots: 8, shotsOnTarget: 4,
  passes: 9, passesCompleted: 7, tackles: 6, clearances: 3, dribbles: 2,
  keyPasses: 4, chancesCreated: 99, shotsFaced: 8, saves: 6,
  highestRating: 8.25, lowestRating: 7.5,
};
function player(recordId = A, id?: unknown, visible = true): AirtableRecord {
  return { id: recordId, fields: {
    "Player ID": arguments.length < 2 ? "alpha" : id, "Official Name EN": recordId === A ? "Alpha" : "Beta",
    "Official Name AR": recordId === A ? "ألفا" : "بيتا",
    "Show On Website": visible, Position: ["CF/GK"], "Points Balance": -1.25,
  } };
}
function row(field: string, owner?: unknown, values: Record<string, unknown> = full, id = "recMonthly1234567"): AirtableRecord {
  return { id, fields: { [field]: arguments.length < 2 ? [A] : owner, ...values } };
}
let tables: Map<string, AirtableRecord[][]>;
let status: string;
let stored: Player[];
let storedAge: number;
let calls: { operation: string; args?: Record<string, unknown>; table?: string; page?: number }[];
let publications: Player[][];
let events: string[];
let logs: unknown[];
const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "LOVABLE_API_KEY", "AIRTABLE_API_KEY"];
let savedEnv: (string | undefined)[];
let savedFetch: typeof fetch;
let savedConsole: typeof console.error;
let savedDateNow: typeof Date.now;
const now = Date.parse("2026-09-09T12:00:00Z");

beforeEach(() => {
  savedEnv = keys.map((key) => process.env[key]);
  savedFetch = globalThis.fetch;
  savedConsole = console.error;
  savedDateNow = Date.now;
  process.env.SUPABASE_URL = "https://coordinator.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_only";
  process.env.LOVABLE_API_KEY = "dummy-lovable-key";
  process.env.AIRTABLE_API_KEY = "dummy-airtable-key";
  Date.now = () => now;
  __testing.setMode("production");
  __testing.setRefreshAhead(false);
  __testing.setMonotonic(() => now);
  __testing.setSleep(async () => {});
  tables = new Map([[AIRTABLE_TABLES.playersDatabase, [[player()]]]]);
  status = "claimed";
  stored = [];
  storedAge = 60_000;
  calls = []; publications = []; events = []; logs = [];
  console.error = (value) => { logs.push(value); events.push("public-error"); };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "coordinator.test") {
      if (url.pathname === "/rest/v1/airtable_public_cache") {
        calls.push({ operation: "stored-read" });
        return Response.json([{ payload: stored,
          refresh_started_at: new Date(now - storedAge).toISOString(),
          fresh_until: new Date(now - storedAge + 900_000).toISOString(),
        }], { headers: { date: new Date(now).toUTCString() } });
      }
      const operation = url.pathname.split("/").at(-1)!;
      const args = JSON.parse(String(init?.body));
      calls.push({ operation, args });
      if (operation === "h2_get_or_claim") return Response.json(status === "fresh"
        ? { status, fresh_for_ms: 900_000 - storedAge, payload: stored }
        : status === "claimed" ? { status, lease_token: "fixture-lease", refresh_deadline_ms: 45000 }
          : { status });
      if (operation === "h2_take_page_permit") return Response.json({ status: "granted", usable_for_ms: 1000, refresh_deadline_ms: 45000 });
      if (operation === "h2_finish_refresh") {
        publications.push(args.p_payload);
        return Response.json({ status: "published" });
      }
      if (operation === "h2_fail_refresh") {
        events.push("cleanup");
        return Response.json({ status: "recorded", released: true });
      }
      throw new Error("Unexpected coordinator operation");
    }
    if (url.hostname === "connector-gateway.lovable.dev") {
      expect(init?.method).toBe("GET");
      const table = url.pathname.split("/").at(-1)!;
      const page = Number(url.searchParams.get("offset") ?? 0);
      const pages = tables.get(table) ?? [[]];
      calls.push({ operation: "airtable", table, page });
      return Response.json({ records: pages[page] ?? [], ...(page + 1 < pages.length ? { offset: String(page + 1) } : {}) });
    }
    throw new Error("Unmocked network access blocked");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  console.error = savedConsole;
  Date.now = savedDateNow;
  __testing.resetMonotonic(); __testing.resetSleep(); __testing.setMode(undefined); __testing.resetRefreshAhead();
  keys.forEach((key, i) => { if (savedEnv[i] === undefined) delete process.env[key]; else process.env[key] = savedEnv[i]; });
  expect(__testing.inFlightSize()).toBe(0);
});

const run = () => withPublicFeedBoundary("players", () => getCachedPublicFeed("players", fetchPlayersFromAirtable));
async function valid(): Promise<Player[]> {
  const input = JSON.stringify([...tables]);
  const result = await run();
  expect(JSON.stringify([...tables])).toBe(input);
  expect(publications).toEqual([result]);
  expect(calls.filter((c) => c.operation === "h2_fail_refresh")).toHaveLength(0);
  expect(logs).toEqual([]);
  return result;
}
async function rejected() {
  const input = JSON.stringify([...tables]);
  let failure: unknown;
  try { await run(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(PUBLIC_ERROR_MESSAGE);
  expect((failure as Error).stack).toBe("");
  expect((failure as Error).cause).toBeUndefined();
  expect(publications).toEqual([]);
  expect(calls.filter((c) => c.operation === "h2_finish_refresh")).toHaveLength(0);
  const failures = calls.filter((c) => c.operation === "h2_fail_refresh");
  expect(failures).toHaveLength(1);
  expect(failures[0]!.args).toMatchObject({ p_kind: "failure", p_retry_after_seconds: null });
  expect(events).toEqual(["cleanup", "public-error"]);
  expect(JSON.stringify(logs)).not.toContain(A);
  expect(JSON.stringify(logs)).not.toContain("Duplicate");
  expect(JSON.stringify([...tables])).toBe(input);
  const permits = calls.filter((c) => c.operation === "h2_take_page_permit");
  const reads = calls.filter((c) => c.operation === "airtable");
  expect(permits).toHaveLength(reads.length);
  expect(permits.map((c) => c.args!.p_sequence)).toEqual(reads.map((_, i) => i + 1));
}

test("unique public identifiers and valid complete output are preserved", async () => {
  tables.set(AIRTABLE_TABLES.playersDatabase, [[player(), player(B, "beta")]]);
  for (const [, table, field] of months) tables.set(table, [[row(field)]]);
  const result = await valid();
  expect(result.map((p) => p.id)).toEqual(["alpha", "beta"]);
  expect(result[0]).toMatchObject({ name: "Alpha", nameAr: "ألفا", points: -1.25,
    positions: ["CF/GK"], positionGroup: "FWD", playsOutfield: true, playsKeeper: true });
  for (const [month] of months) expect(result[0]!.stats[month]).toEqual(expectedMonth);
  expect(result[1]!.stats).toEqual({});
});

test("live ownership field names link every configured month to visible players", async () => {
  tables.set(AIRTABLE_TABLES.playersDatabase, [[player()]]);
  for (const [, table, field] of months) tables.set(table, [[row(field)]]);
  const result = await valid();
  expect(Object.keys(result[0]!.stats).sort()).toEqual(months.map(([m]) => m).sort());
});

for (const variant of [
  (name: string) => name.toUpperCase(),
  (name: string) => name.toLowerCase(),
  (name: string) => `  ${name} `,
]) {
  test(`ownership field name variant ${JSON.stringify(variant("Players DATABASE 2"))} still links stats`, async () => {
    tables.set(AIRTABLE_TABLES.playersDatabase, [[player()]]);
    for (const [, table, field] of months) tables.set(table, [[row(variant(field))]]);
    const result = await valid();
    for (const [month] of months) expect(result[0]!.stats[month]).toEqual(expectedMonth);
  });
}

test("a same-named plain text field is never used as the ownership link", async () => {
  tables.set(AIRTABLE_TABLES.playersDatabase, [[player()]]);
  // August/September carry a text "احصائيات اللاعب" and September a text
  // "Players DATABASE": text values must never resolve ownership.
  for (const [, table, field] of months) {
    tables.set(table, [[{ id: "recMonthly1234567", fields: { [field]: "Alpha", ...full } }]]);
  }
  const result = await valid();
  expect(result[0]!.stats).toEqual({});
});

test("an unrelated link field never resolves ownership", async () => {
  tables.set(AIRTABLE_TABLES.playersDatabase, [[player()]]);
  for (const [, table] of months) {
    tables.set(table, [[{ id: "recMonthly1234567", fields: { Records: [A], ...full } }]]);
  }
  const result = await valid();
  expect(result[0]!.stats).toEqual({});
});

test("hidden players stay hidden even when monthly rows link to them", async () => {
  tables.set(AIRTABLE_TABLES.playersDatabase, [[player(A, "alpha", false)]]);
  for (const [, table, field] of months) tables.set(table, [[row(field)]]);
  expect(await valid()).toEqual([]);
});

test("Points Balance is carried through when Airtable holds a value", async () => {
  tables.set(AIRTABLE_TABLES.playersDatabase, [[player()]]);
  const result = await valid();
  expect(result[0]!.points).toBe(-1.25);
});

test("a blank Points Balance stays null rather than becoming a number", async () => {
  const blank = player();
  delete blank.fields["Points Balance"];
  tables.set(AIRTABLE_TABLES.playersDatabase, [[blank]]);
  const result = await valid();
  expect(result[0]!.points).toBeNull();
});


for (const paginated of [false, true]) {
  for (const ids of [["same", "same"], [" same ", "same"], [B, ""]]) {
    test(`duplicate final IDs ${JSON.stringify(ids)}${paginated ? " across pages" : ""} fail closed`, async () => {
      const rows = [player(A, ids[0]), player(B, ids[1])];
      tables.set(AIRTABLE_TABLES.playersDatabase, paginated ? rows.map((r) => [r]) : [rows]);
      await rejected();
    });
  }
}
for (const raw of ["", "   ", null, undefined, 123]) {
  test(`existing record-ID fallback for ${JSON.stringify(raw)} is preserved`, async () => {
    tables.set(AIRTABLE_TABLES.playersDatabase, [[player(A, raw), player(B, raw)]]);
    expect((await valid()).map((p) => p.id)).toEqual([A, B]);
  });
}
test("trimmed identifiers stay case-sensitive", async () => {
  tables.set(AIRTABLE_TABLES.playersDatabase, [[player(A, " Same "), player(B, "same")]]);
  expect((await valid()).map((p) => p.id)).toEqual(["Same", "same"]);
});
for (const excluded of ["hidden", "nameless"]) {
  test(`${excluded} player does not collide with an eligible public ID`, async () => {
    const other = player(B, "alpha", excluded !== "hidden");
    if (excluded === "nameless") { other.fields["Official Name EN"] = ""; other.fields["Official Name AR"] = ""; }
    tables.set(AIRTABLE_TABLES.playersDatabase, [[player(), other]]);
    expect((await valid()).map((p) => p.id)).toEqual(["alpha"]);
  });
}

for (const [month, table, field] of months) {
  test(`${month}: exact authoritative field ${field} preserves all monthly values`, async () => {
    tables.set(table, [[row(field)]]);
    const [p] = await valid();
    expect(p!.stats).toEqual({ [month]: expectedMonth });
    const out = aggregateOutfield(p!, month), keeper = aggregateKeeper(p!, month)!;
    expect([out.highestRating, out.lowestRating, out.mvpAwards, out.chancesCreated]).toEqual([8.25, 7.5, 2, 5]);
    expect([keeper.saves, keeper.shotsFaced, keeper.goalsConceded, keeper.savePercentage]).toEqual([6, 8, 2, 75]);
  });
  for (const values of [full, { Assists: 7 }]) {
    for (const reversed of [false, true]) {
      for (const paginated of [false, true]) {
        test(`${month}: ${values === full ? "full/full" : "full/partial"} duplicate reverse=${reversed} pages=${paginated}`, async () => {
          const rows = [row(field), row(field, [A], values, "recSecond12345678")];
          if (reversed) rows.reverse();
          tables.set(table, paginated ? rows.map((r) => [r]) : [rows]);
          await rejected();
          if (paginated) expect(calls.some((c) => c.table === table && c.page === 1)).toBe(true);
        });
      }
    }
  }
  for (const ignored of [{}, { MVP: 9 }, { POTM: true }]) {
    for (const reversed of [false, true]) {
      test(`${month}: ignored blank/MVP-only row ${JSON.stringify(ignored)} reverse=${reversed}`, async () => {
        const rows = [row(field), row(field, [A, B], ignored, "recIgnored1234567")];
        if (reversed) rows.reverse();
        tables.set(AIRTABLE_TABLES.playersDatabase, [[player(), player(B, "beta")]]);
        tables.set(table, [rows]);
        expect((await valid())[0]!.stats[month]).toEqual(expectedMonth);
      });
    }
  }
  test(`${month}: unrelated arrays cannot assign or overwrite another player's statistics`, async () => {
    tables.set(AIRTABLE_TABLES.playersDatabase, [[player(), player(B, "beta")]]);
    tables.set(table, [[row(field, [B], { Goals: 1 }), row(field, [A], { ...full, Player: [B], OtherArray: [B] }, "recOtherRow123456")]]);
    const result = await valid();
    expect(result[0]!.stats[month]!.goals).toBe(2);
    expect(result[1]!.stats[month]!.goals).toBe(1);
  });
  test(`${month}: wrong authoritative-month fields and legacy Player are ignored`, async () => {
    const wrong = Object.fromEntries(["Player", "Other", ...months.map((m) => m[2])].filter((f) => f !== field).map((f) => [f, [A]]));
    tables.set(table, [[{ id: "recWrongField1234", fields: { ...full, ...wrong } }]]);
    expect((await valid())[0]!.stats).toEqual({});
  });
  for (const owner of [[A], [A, A, A], [A, U], [U, A], [A, null, 42]]) {
    test(`${month}: one resolved owner ${JSON.stringify(owner)}`, async () => {
      tables.set(table, [[row(field, owner)]]);
      expect((await valid())[0]!.stats[month]).toEqual(expectedMonth);
    });
  }
  for (const owner of [undefined, null, [], [U], ["Alpha", "alpha"], A, [null, 42]]) {
    test(`${month}: missing/unresolved owner ${JSON.stringify(owner)} remains unassigned`, async () => {
      tables.set(table, [[row(field, owner)]]);
      expect((await valid())[0]!.stats).toEqual({});
    });
  }
  for (const hidden of [false, true]) {
    test(`${month}: multiple distinct master owners, hidden=${hidden}, reject`, async () => {
      tables.set(AIRTABLE_TABLES.playersDatabase, [[player(), player(B, "beta", !hidden)]]);
      tables.set(table, [[row(field, [A, B, A])]]);
      await rejected();
    });
  }
  test(`${month}: a hidden owner's rows, including duplicates, remain excluded`, async () => {
    tables.set(AIRTABLE_TABLES.playersDatabase, [[player(), player(B, "alpha", false)]]);
    tables.set(table, [[row(field, [B]), row(field, [B], { Goals: 50 }, "recHiddenSecond12")]]);
    const result = await valid();
    expect(result).toHaveLength(1);
    expect(result[0]!.stats).toEqual({});
  });
  for (const [awards, expected] of [[{}, 0], [{ POTM: true }, 1], [{ MVP: 0, POTM: true }, 0], [{ MVP: 3, POTM: true }, 3]] as const) {
    test(`${month}: existing MVP convention ${JSON.stringify(awards)}`, async () => {
      tables.set(table, [[row(field, [A], { Goals: 0, ...awards })]]);
      expect((await valid())[0]!.stats[month]!.mvpAwards).toBe(expected);
    });
  }
}

test("a player's valid rows in different months are not duplicates", async () => {
  for (const [, table, field] of months) tables.set(table, [[row(field)]]);
  expect(Object.keys((await valid())[0]!.stats)).toEqual(months.map((m) => m[0]));
});
test("different players in one month remain independent", async () => {
  tables.set(AIRTABLE_TABLES.playersDatabase, [[player(), player(B, "beta")]]);
  tables.set(months[0]![1], [[row(months[0]![2]), row(months[0]![2], [B], { Goals: 9 }, "recOtherOwner1234")]]);
  expect((await valid()).map((p) => p.stats["2026-06"]!.goals)).toEqual([2, 9]);
});
test("fresh cache remains usable without loading even when source data has duplicates", async () => {
  stored = await valid();
  publications = []; calls = []; status = "fresh";
  tables.set(AIRTABLE_TABLES.playersDatabase, [[player(), player(B, "alpha")]]);
  expect(await run()).toEqual(stored);
  expect(calls.map((c) => c.operation)).toEqual(["h2_get_or_claim"]);
  expect(publications).toEqual([]);
});
test("a rejected validation refresh does not replace prior stored data or return expired data", async () => {
  stored = await valid();
  const previous = structuredClone(stored);
  storedAge = 900_000; publications = []; calls = [];
  tables.set(AIRTABLE_TABLES.playersDatabase, [[player(), player(B, "alpha")]]);
  await rejected();
  expect(stored).toEqual(previous);
});
test("post-failure cooldown denies further upstream work and expires cached responses normally", async () => {
  stored = await valid();
  status = "cooldown"; calls = []; publications = [];
  expect(await run()).toEqual(stored);
  expect(calls.some((c) => c.operation === "airtable" || c.operation === "h2_take_page_permit")).toBe(false);
  storedAge = 900_000; calls = [];
  await expect(run()).rejects.toThrow(PUBLIC_ERROR_MESSAGE);
  expect(calls.some((c) => c.operation === "airtable" || c.operation === "h2_take_page_permit")).toBe(false);
  expect(publications).toEqual([]);
});
