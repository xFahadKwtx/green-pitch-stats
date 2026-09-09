/** M4: run separately from other module-mocking suites. No real upstream access. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Player } from "../src/data/types";
import type { AirtableRecord } from "../src/lib/airtable.server";
import { num, numOrNA, pct, pctOrNA, pointsBalance, rating, ratingOrNA } from "../src/lib/format";

const actualAirtable = await import("../src/lib/airtable.server");
const actualRouter = await import("@tanstack/react-router");
const { AIRTABLE_TABLES } = actualAirtable;
const PLAYER_RECORD = "recPlayer12345678";
let lang: "en" | "ar" = "en";
let playerRows: AirtableRecord[] = [];
let profilePlayer: Player;
let reads: string[] = [];
const monthRow: AirtableRecord = { id: "recMonth123456789", fields: {
  Player: [PLAYER_RECORD], "Games played": 3, Goals: 2, Assists: 1,
  "SHOTS ttl - SOT": "8 - 4", Passes: "9 - 7", Tackles: 6, Clearences: 3,
  "Highest Rating": 8.25, "Lowest Rating": 7.5, MVP: 1, "GK saves": "8 - 6",
} };

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("Real network access is forbidden in M4 tests"); }) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

mock.module("../src/lib/airtable.server", () => ({
  ...actualAirtable,
  listAirtableRecords: async (table: string) => {
    reads.push(table);
    if (table === AIRTABLE_TABLES.playersDatabase) return playerRows;
    if (table === AIRTABLE_TABLES.statsAugust) return [monthRow];
    if ([AIRTABLE_TABLES.statsJune, AIRTABLE_TABLES.statsJuly, AIRTABLE_TABLES.statsSeptember].includes(table)) return [];
    throw new Error("Unexpected table");
  },
}));
mock.module("@tanstack/react-router", () => ({
  ...actualRouter,
  Link: ({ children }: { children: ReactNode }) => createElement("a", { href: "/players" }, children),
}));
mock.module("../src/lib/players-query", () => ({ playersQueryOptions: {} }));
mock.module("../src/lib/i18n", () => ({
  useI18n: () => ({ lang, t: (key: string) => key === "profile.points" ? (lang === "ar" ? "رصيد النقاط" : "Points Balance") : key }),
}));
mock.module("../src/components/ui-kit", () => ({
  PageShell: ({ children }: { children: ReactNode }) => createElement("main", null, children),
  SectionTitle: ({ children }: { children: ReactNode }) => createElement("h2", null, children),
  MonthFilter: () => null,
  StatCard: ({ label, value }: { label: string; value: string }) => createElement("div", { "data-stat": label }, value),
}));

const { fetchPlayersFromAirtable } = await import("../src/lib/airtable-players.server");
const { Route } = await import("../src/routes/players.$playerId");
const originalLoaderHook = Route.useLoaderData;
Route.useLoaderData = (() => ({ player: profilePlayer })) as typeof Route.useLoaderData;
afterAll(() => { Route.useLoaderData = originalLoaderHook; });
const PlayerProfile = Route.options.component as ComponentType;

beforeEach(() => { lang = "en"; reads = []; playerRows = []; });

function rawPlayer(balance: unknown): AirtableRecord {
  return { id: PLAYER_RECORD, fields: {
    "Show On Website": true, "Player ID": "player-1", "Official Name EN": "Player One",
    "Official Name AR": "اللاعب الأول", Position: ["CM", "GK"], "Points Balance": balance,
  } };
}

const examples = [
  [0, "0", "٠"], [0.25, "0.25", "٠٫٢٥"], [0.50, "0.5", "٠٫٥"],
  [0.75, "0.75", "٠٫٧٥"], [1, "1", "١"], [1.25, "1.25", "١٫٢٥"],
  [1.50, "1.5", "١٫٥"], [10.75, "10.75", "١٠٫٧٥"],
  [-0.25, "-0.25", "\u061c-٠٫٢٥"], [-0.50, "-0.5", "\u061c-٠٫٥"],
  [-0.75, "-0.75", "\u061c-٠٫٧٥"], [-1.50, "-1.5", "\u061c-١٫٥"],
  [1234.50, "1,234.5", "١٬٢٣٤٫٥"], [null, "0", "٠"],
] as const;

for (const language of ["en", "ar"] as const) {
  describe(`${language}: balance precision and actual Player Profile`, () => {
    for (const [balance, english, arabic] of examples) {
      const expected = language === "en" ? english : arabic;
      test(`formatter ${balance} -> ${expected} without unnecessary decimals`, () => {
        expect(pointsBalance(balance, language)).toBe(expected);
      });

      test(`Airtable ${balance} stays unchanged and renders as ${expected} on the Profile`, async () => {
        lang = language;
        playerRows = [rawPlayer(balance)];
        const originalRows = JSON.stringify(playerRows);
        const players = await fetchPlayersFromAirtable();
        expect(players.length).toBe(1);
        profilePlayer = players[0]!;
        expect(profilePlayer.points).toBe(balance);
        expect(reads).toEqual([
          AIRTABLE_TABLES.playersDatabase, AIRTABLE_TABLES.statsJune, AIRTABLE_TABLES.statsJuly,
          AIRTABLE_TABLES.statsAugust, AIRTABLE_TABLES.statsSeptember,
        ]);
        const originalPlayer = JSON.stringify(profilePlayer);
        const html = renderToStaticMarkup(createElement(PlayerProfile));
        const displayed = html.match(/<p class="stat-number mt-1 text-4xl text-gold sm:text-5xl">([^<]*)<\/p>/);
        expect(displayed).not.toBeNull();
        expect(displayed![1]).toBe(expected);
        expect(html).toContain(language === "en" ? "Points Balance" : "رصيد النقاط");
        expect(JSON.stringify(profilePlayer)).toBe(originalPlayer);
        expect(JSON.stringify(playerRows)).toBe(originalRows);

        // The actual Profile still uses integer, percentage and rating formatters
        // for its statistics, independently of the fractional balance display.
        const stats = language === "en"
          ? { "stat.games": "3", "stat.goals": "2", "stat.assists": "1", "stat.shots": "8",
              "stat.tackles": "6", "stat.passAcc": "77.8%", "stat.savePct": "75%",
              "stat.highRating": "8.25", "stat.lowRating": "7.50" }
          : { "stat.games": "٣", "stat.goals": "٢", "stat.assists": "١", "stat.shots": "٨",
              "stat.tackles": "٦", "stat.passAcc": "٧٧٫٨%", "stat.savePct": "٧٥%",
              "stat.highRating": "٨٫٢٥", "stat.lowRating": "٧٫٥٠" };
        for (const [label, value] of Object.entries(stats)) {
          expect(html).toContain(`<div data-stat="${label}">${value}</div>`);
        }
      });
    }

    test("existing integer formatting remains unchanged", () => {
      const expected = language === "en" ? ["0", "1", "1,234", "0", "2"] : ["٠", "١", "١٬٢٣٤", "٠", "٢"];
      for (const [i, value] of [0, 1, 1234, 0.25, 1.5].entries()) {
        expect(num(value, language)).toBe(expected[i]);
        expect(numOrNA(value, language)).toBe(expected[i]);
      }
      expect(numOrNA(null, language)).toBe(language === "en" ? "0" : "٠");
    });

    test("existing percentage and rating formatting remain unchanged", () => {
      expect(pct(37.25, language)).toBe(language === "en" ? "37.3%" : "٣٧٫٣%");
      expect(pctOrNA(37.25, language)).toBe(language === "en" ? "37.3%" : "٣٧٫٣%");
      expect(pctOrNA(null, language)).toBe(language === "en" ? "0%" : "٠%");
      expect(rating(7.5, language)).toBe(language === "en" ? "7.50" : "٧٫٥٠");
      expect(ratingOrNA(7.5, language)).toBe(language === "en" ? "7.50" : "٧٫٥٠");
      expect(ratingOrNA(null, language)).toBe(language === "en" ? "0.00" : "٠٫٠٠");
    });
  });
}

test("decimal Airtable strings retain their numeric values without whole-point rounding", async () => {
  for (const text of ["0.25", "0.50", "0.75", "1.50", "10.75", "-0.25", "-1.50"]) {
    playerRows = [rawPlayer(text)];
    const players = await fetchPlayersFromAirtable();
    expect(players[0]!.points).toBe(Number(text));
    expect(playerRows[0]!.fields["Points Balance"]).toBe(text);
  }
});

test("an absent Airtable balance stays null while its display stays zero", async () => {
  const record = rawPlayer(undefined);
  delete record.fields["Points Balance"];
  playerRows = [record];
  const [player] = await fetchPlayersFromAirtable();
  expect(player!.points).toBeNull();
  expect(pointsBalance(player!.points, "en")).toBe("0");
  expect(pointsBalance(player!.points, "ar")).toBe("٠");
  expect(record.fields).not.toHaveProperty("Points Balance");
});
