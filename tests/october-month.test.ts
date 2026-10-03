import { afterAll, expect, mock, test } from "bun:test";
import * as actualAirtable from "../src/lib/airtable.server";
import { AIRTABLE_TABLES, type AirtableRecord } from "../src/lib/airtable.server";
import { MONTHS } from "../src/data/types";

const A = "recAlpha12345678", B = "recBeta123456789";
const stats = (goals: number) => ({ "Games played": 2, Goals: goals, Assists: 1, Passes: "10 - 8" });
const players: AirtableRecord[] = [A, B].map((id, i) => ({ id, fields: {
  "Player ID": `p${i}`, "Official Name EN": `P${i}`, "Official Name AR": `ل${i}`,
  "Show On Website": true, Position: ["CM"],
} }));
const tables: Record<string, AirtableRecord[]> = {
  [AIRTABLE_TABLES.playersDatabase]: players,
  [AIRTABLE_TABLES.statsJune]: [],
  [AIRTABLE_TABLES.statsJuly]: [],
  [AIRTABLE_TABLES.statsAugust]: [],
  [AIRTABLE_TABLES.statsSeptember]: [{ id: "recSep", fields: { "Players DATABASE 2": [A], ...stats(3) } }],
  [AIRTABLE_TABLES.statsOctober]: [
    { id: "recOct1", fields: { "Players DATABASE 2": [A], ...stats(4) } },
    // Blank row and text-only same-named field are ignored.
    { id: "recOct2", fields: { "Players DATABASE 2": [B] } },
    { id: "recOct3", fields: { "احصائيات اللاعب": "P1", ...stats(9) } },
  ],
};
const reads: string[] = [];
mock.module("../src/lib/airtable.server", () => ({
  ...actualAirtable,
  listAirtableRecords: async (t: string) => { reads.push(t); return tables[t] ?? []; },
}));
afterAll(() => mock.restore());

test("October is enabled once with the new table", () => {
  expect(MONTHS).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  expect(AIRTABLE_TABLES.statsOctober).toBe("tblHjLFOBQngSaERO");
});

test("October links through Players DATABASE 2, skips blanks, sums once in All", async () => {
  const { fetchPlayersFromAirtable } = await import("../src/lib/airtable-players.server");
  const { aggregateOutfield } = await import("../src/lib/stats");
  const [a, b] = await fetchPlayersFromAirtable();
  expect(reads).toContain(AIRTABLE_TABLES.statsOctober);
  expect(a!.stats["2026-10"]?.goals).toBe(4);
  expect(a!.stats["2026-09"]?.goals).toBe(3);
  expect(b!.stats["2026-10"]).toBeUndefined();
  expect(aggregateOutfield(a!, "2026-10").goals).toBe(4);
  expect(aggregateOutfield(a!, "2026-09").goals).toBe(3);
  const all = aggregateOutfield(a!, "all");
  expect(all.months).toEqual(["2026-09", "2026-10"]);
  expect(all.goals).toBe(7);
  expect(all.gamesPlayed).toBe(4);
});
