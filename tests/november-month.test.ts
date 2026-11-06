import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as actualAirtable from "../src/lib/airtable.server";
import { AIRTABLE_TABLES, type AirtableRecord } from "../src/lib/airtable.server";
import { MONTHS } from "../src/data/types";
import { aggregateOutfield, recordedMonths } from "../src/lib/stats";

const A = "recAlpha12345678", B = "recBeta123456789";
const values = (goals: number) => ({ "Games played": 2, Goals: goals });
const masters: AirtableRecord[] = [A, B].map((id, i) => ({ id, fields: {
  "Player ID": `p${i}`, "Official Name EN": `P${i}`, "Official Name AR": `ل${i}`,
  "Show On Website": true, Position: ["CM"],
} }));
let november: AirtableRecord[] = [];
let reads: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("No real network allowed"); }) as typeof fetch;
mock.module("../src/lib/airtable.server", () => ({
  ...actualAirtable,
  listAirtableRecords: async (table: string) => {
    reads.push(table);
    if (table === AIRTABLE_TABLES.playersDatabase) return masters;
    if (table === AIRTABLE_TABLES.statsNovember) return november;
    if (table === AIRTABLE_TABLES.statsOctober) return [{ id: "recOct", fields: {
      "Players DATABASE 2": [A], ...values(3),
    } }];
    return [];
  },
}));
const { fetchPlayersFromAirtable } = await import("../src/lib/airtable-players.server");
beforeEach(() => { november = []; reads = []; });
afterAll(() => { mock.restore(); globalThis.fetch = realFetch; });

test("November is appended exactly once and uses the approved table", () => {
  expect(MONTHS).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
  expect(MONTHS.filter(m => m === "2026-11")).toHaveLength(1);
  expect(AIRTABLE_TABLES.statsNovember).toBe("tblU6v33RPHb4rad1");
});

test("empty November creates no stats and does not change October or All", async () => {
  const players = await fetchPlayersFromAirtable();
  const a = players[0];
  if (!a) throw new Error("Missing fixture player");
  expect(players).toHaveLength(2);
  expect(players.every(p => p.stats["2026-11"] === undefined)).toBe(true);
  expect(recordedMonths(a, "2026-11")).toEqual([]);
  expect(aggregateOutfield(a, "all").months).toEqual(["2026-10"]);
  expect(aggregateOutfield(a, "all").goals).toBe(3);
  expect(reads.filter(t => t === AIRTABLE_TABLES.statsNovember)).toHaveLength(1);
});

test("real linked ownership, blank rows and missing cells remain strict; All sums each month once", async () => {
  november = [
    { id: "recNovA", fields: { "Players DATABASE 2": [A], ...values(4) } },
    { id: "recBlank", fields: { "Players DATABASE 2": [B] } },
    { id: "recText", fields: { "Players DATABASE 2": "p1", ...values(99) } },
    { id: "recPublicId", fields: { "Players DATABASE 2": ["p1"], ...values(99) } },
    { id: "recWrongField", fields: { "Players DATABASE": [B], ...values(99) } },
  ];
  const [a, b] = await fetchPlayersFromAirtable();
  if (!a || !b) throw new Error("Missing fixture players");
  expect(a.stats["2026-11"]?.goals).toBe(4);
  expect(a.stats["2026-11"]?.assists).toBeNull();
  expect(b.stats["2026-11"]).toBeUndefined();
  expect(aggregateOutfield(a, "2026-11").goals).toBe(4);
  expect(aggregateOutfield(a, "2026-10").goals).toBe(3);
  const all = aggregateOutfield(a, "all");
  expect(all.months).toEqual(["2026-10", "2026-11"]);
  expect(all.goals).toBe(7);
  expect(all.gamesPlayed).toBe(4);
});

test("ambiguous November ownership fails rather than assigning stats arbitrarily", async () => {
  november = [{ id: "recAmbiguous", fields: { "Players DATABASE 2": [A, B], ...values(4) } }];
  await expect(fetchPlayersFromAirtable()).rejects.toThrow("Ambiguous monthly player ownership");
});

test("duplicate November rows fail rather than double counting", async () => {
  november = ["recOne", "recTwo"].map(id => ({ id, fields: { "Players DATABASE 2": [A], ...values(4) } }));
  await expect(fetchPlayersFromAirtable()).rejects.toThrow("Duplicate monthly player statistics");
});