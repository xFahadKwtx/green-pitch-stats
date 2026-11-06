import { afterAll, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as actualAirtable from "../src/lib/airtable.server";
import { AIRTABLE_TABLES, type AirtableRecord } from "../src/lib/airtable.server";
import { DoublePointsBadge } from "../src/components/double-points-badge";

const base = (id: string, extra: Record<string, unknown>): AirtableRecord => ({
  id: `rec${id}000000000000`,
  fields: { "Player ID": id, "Official Name EN": id, "Official Name AR": id, "Show On Website": true, Position: ["CM"], "Points Balance": 40, ...extra },
});
const masters = [
  base("on", { "Double Points": true }),
  base("off", { "Double Points": false }),
  base("missing", {}),
  base("truthy", { "Double Points": "true" }),
];
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("No real network allowed"); }) as typeof fetch;
mock.module("../src/lib/airtable.server", () => ({
  ...actualAirtable,
  listAirtableRecords: async (table: string) => (table === AIRTABLE_TABLES.playersDatabase ? masters : []),
}));
const { fetchPlayersFromAirtable } = await import("../src/lib/airtable-players.server");
afterAll(() => { mock.restore(); globalThis.fetch = realFetch; });

test("Double Points is true only for an exact Airtable true; points unchanged", async () => {
  const byId = Object.fromEntries((await fetchPlayersFromAirtable()).map((p) => [p.id, p]));
  expect(byId.on?.doublePoints).toBe(true);
  expect(byId.off?.doublePoints).toBe(false);
  expect(byId.missing?.doublePoints).toBe(false);
  expect(byId.truthy?.doublePoints).toBe(false);
  expect(byId.on?.points).toEqual(byId.off?.points);
});

test("badge renders only when active, with translated label", () => {
  const on = renderToStaticMarkup(createElement(DoublePointsBadge, { active: true, label: "نقاط مضاعفة" }));
  expect(on).toContain("2X");
  expect(on).toContain('aria-label="نقاط مضاعفة"');
  expect(renderToStaticMarkup(createElement(DoublePointsBadge, { active: false, label: "x" }))).toBe("");
  expect(renderToStaticMarkup(createElement(DoublePointsBadge, { label: "x" }))).toBe("");
});
