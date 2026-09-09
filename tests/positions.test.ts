/** M6: run separately from other module-mocking suites. No real upstream calls. */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { ComponentType, ReactNode } from "react";
import type { Player, Position } from "../src/data/types";
import type { AirtableRecord } from "../src/lib/airtable.server";
import { aggregateKeeper, aggregateOutfield } from "../src/lib/stats";
import { leaderboard, type Category } from "../src/lib/leaderboard";

const react = await import("react");
const originalUseState = react.useState;
const router = await import("@tanstack/react-router");
const airtable = await import("../src/lib/airtable.server");
let language: "en" | "ar" = "en";
let states: unknown[] = [];
let records: AirtableRecord[] = [];
let players: Player[] = [];
let profilePlayer: Player;
let monthFields: Record<string, unknown>;
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("Real network access is forbidden in M6 tests"); }) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

mock.module("react", () => ({
  ...react,
  // Select UI state through the real React hook; render the actual components.
  useState: (initial: unknown) => originalUseState(
    initial === "en" ? language : states.length ? states.shift() : initial,
  ),
}));
mock.module("@tanstack/react-router", () => ({
  ...router,
  Link: ({ children, params, className }: { children: ReactNode; params?: { playerId: string }; className?: string }) =>
    react.createElement("a", { href: `/players/${params?.playerId ?? ""}`, className }, children),
}));
mock.module("@tanstack/react-query", () => ({ useSuspenseQuery: () => ({ data: players }) }));
mock.module("../src/lib/players-query", () => ({ playersQueryOptions: {} }));
mock.module("../src/lib/airtable.server", () => ({
  ...airtable,
  listAirtableRecords: async (table: string) => {
    if (table === airtable.AIRTABLE_TABLES.playersDatabase) return records;
    if (table === airtable.AIRTABLE_TABLES.statsJune) {
      return records.map((r) => ({ id: `${r.id}Month`, fields: { Player: [r.id], ...monthFields } }));
    }
    return [];
  },
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { I18nProvider } = await import("../src/lib/i18n");
const { fetchPlayersFromAirtable } = await import("../src/lib/airtable-players.server");
const { Route: directory } = await import("../src/routes/players.index");
const { Route: profile } = await import("../src/routes/players.$playerId");
const { Route: compare } = await import("../src/routes/compare");
const originalLoaderHook = profile.useLoaderData;
profile.useLoaderData = (() => ({ player: profilePlayer })) as typeof profile.useLoaderData;
afterAll(() => { profile.useLoaderData = originalLoaderHook; });

beforeEach(() => {
  language = "en";
  states = [];
  records = [];
  players = [];
  monthFields = {
    "Games played": 3, Goals: 2, Assists: 1, MVP: 1,
    "SHOTS ttl - SOT": "8 - 4", Passes: "9 - 7", Tackles: 6, Clearences: 3,
    "Successful Dribbles": 2, KeyPasses: 4, "Chances Created": 99,
    "GK saves": "8 - 6", "Highest Rating": 8.25, "Lowest Rating": 7.5,
  };
});

const labels = {
  en: { FWD: "FORWARD", MID: "MIDFIELDER", DEF: "DEFENDER", GK: "GOALKEEPER" },
  ar: { FWD: "مهاجم", MID: "وسط", DEF: "مدافع", GK: "حارس" },
};
const codeGroups: [string, Position][] = [
  ...["ST", "RW", "LW", "FWD", "CF"].map((c) => [c, "FWD"] as [string, Position]),
  ...["CM", "CDM", "CAM", "MID", "RM", "LM"].map((c) => [c, "MID"] as [string, Position]),
  ...["CB", "RB", "LB", "DEF", "RWB", "LWB"].map((c) => [c, "DEF"] as [string, Position]),
  ["GK", "GK"],
];
const combined: [string, Position[]][] = [
  ["ST/RW", ["FWD"]], ["CM/CDM", ["MID"]], ["CF/ST", ["FWD"]],
  ["CB/RWB", ["DEF"]], ["RWB/RM", ["DEF", "MID"]],
  ["CM/GK", ["MID", "GK"]], ["CF/GK", ["FWD", "GK"]],
  ["ST/GK", ["FWD", "GK"]], ["ST/CM", ["FWD", "MID"]], ["CB/RM", ["DEF", "MID"]],
];

async function loadPositions(position: unknown, index = 1) {
  const raw = { id: `recPlayer${String(index).padStart(8, "0")}`, fields: {
    "Show On Website": true, "Player ID": String(index),
    "Official Name EN": `Fixture ${index}`, "Official Name AR": `لاعب ${index}`,
    Position: position, "Points Balance": -1.25,
  } };
  const original = JSON.stringify(raw);
  records = [raw];
  players = await fetchPlayersFromAirtable();
  expect(JSON.stringify(raw)).toBe(original);
  expect(players).toHaveLength(1);
  profilePlayer = players[0]!;
  return profilePlayer;
}

function render(route: typeof directory | typeof profile | typeof compare, values: unknown[]) {
  states = [...values];
  const html = renderToStaticMarkup(react.createElement(I18nProvider, null,
    react.createElement(route.options.component as ComponentType),
  ));
  expect(states).toHaveLength(0);
  return html;
}

function categoryText(html: string) {
  return html.match(/<span class="block truncate text-sm text-muted-foreground">([^<]*)<\/span>/)?.[1];
}

function checkRoles(p: Player, groups: Position[]) {
  const outfield = groups.some((g) => g !== "GK");
  const keeper = groups.includes("GK");
  expect(p.playsOutfield).toBe(outfield);
  expect(p.playsKeeper).toBe(keeper);
  expect(p.positionGroup).toBe(groups.find((g) => g !== "GK") ?? (keeper ? "GK" : "MID"));
  for (const cat of ["scorer", "assists", "defender", "passing"] as Category[]) {
    expect(leaderboard(cat, "2026-06", [p])).toHaveLength(outfield ? 1 : 0);
  }
  expect(leaderboard("keeper", "2026-06", [p])).toHaveLength(keeper ? 1 : 0);
  expect(leaderboard("potm", "2026-06", [p])).toHaveLength(1);
  expect(aggregateKeeper(p, "2026-06") !== null).toBe(keeper);
}

function checkDirectory(groups: Position[]) {
  for (const lang of ["en", "ar"] as const) {
    language = lang;
    const html = render(directory, ["", "all"]);
    expect(categoryText(html)).toBe(groups.map((g) => labels[lang][g]).join(" • "));
    for (const filter of ["FWD", "MID", "DEF", "GK"] as Position[]) {
      const filtered = render(directory, ["", filter]);
      expect(filtered.includes('href="/players/1"')).toBe(groups.includes(filter));
    }
  }
  language = "en";
}

for (const [code, group] of codeGroups) {
  test(`${code}: mapping, both localized labels, filters and all leaderboard categories`, async () => {
    const p = await loadPositions([code]);
    checkRoles(p, [group]);
    checkDirectory([group]);
    expect(p.positions).toEqual([code]);
    const html = render(profile, ["all"]);
    expect(html.includes("Outfield Stats")).toBe(group !== "GK");
    expect(html.includes("Goalkeeper Stats")).toBe(group === "GK");
  });
}

for (const [text, groups] of combined) {
  for (const separate of [false, true]) {
    test(`${text}: ${separate ? "separate entries" : "combined entry"} preserves categories and roles`, async () => {
      const raw = separate ? text.split("/") : [text];
      const p = await loadPositions(raw);
      checkRoles(p, groups);
      checkDirectory(groups);
      expect(p.positions).toEqual(raw);
      const html = render(profile, ["all"]);
      expect(html.includes("Outfield Stats")).toBe(groups.some((g) => g !== "GK"));
      expect(html.includes("Goalkeeper Stats")).toBe(groups.includes("GK"));
      expect(html).toContain(raw.join(" · "));
    });
  }
}

for (const separator of ["/", "-", ",", "•", " ", "\t", "\n"]) {
  test(`separator ${JSON.stringify(separator)} handles case, whitespace and duplicate categories`, async () => {
    const raw = `  st${separator}rw${separator}cf${separator}cm${separator}gk  `;
    const p = await loadPositions([raw]);
    checkRoles(p, ["FWD", "MID", "GK"]);
    checkDirectory(["FWD", "MID", "GK"]);
    expect(p.positions).toEqual([raw.trim().toUpperCase()]);
  });
}

for (const [raw, groups] of [
  [["GK/CM/ST/GK"], ["GK", "MID", "FWD"]],
  [["LWB", "CM", "ST", "GK", "LWB"], ["DEF", "MID", "FWD", "GK"]],
  [["UNKNOWN", "CF", "CF", "ST"], ["FWD"]],
  [["CM", "ST/GK"], ["MID", "FWD", "GK"]],
  [["GK", "RWB/RM"], ["GK", "DEF", "MID"]],
  [["RM/RWB"], ["MID", "DEF"]],
] as [string[], Position[]][]) {
  test(`${raw.join(" + ")}: token order, deduplication and primary outfield precedence`, async () => {
    checkRoles(await loadPositions(raw), groups);
    checkDirectory(groups);
  });
}

for (const raw of [[], [""], ["   "], ["UNKNOWN"], ["ST|GK"], ["ST;GK"], null, undefined, "CF", [null, 3]]) {
  test(`unrecognized/empty ${JSON.stringify(raw)} keeps fallback and does not invent category text`, async () => {
    checkRoles(await loadPositions(raw), []);
    checkDirectory([]);
  });
}

for (const [left, right, outfield, keeper] of [
  ["CF", "RWB", true, false], ["CF/GK", "CM/GK", true, true],
  ["GK", "CF/GK", false, true], ["GK", "CF", false, false],
] as [string, string, boolean, boolean][]) {
  test(`actual Compare ${left} versus ${right} uses the corrected role flags`, async () => {
    const a = await loadPositions([left], 1);
    const b = await loadPositions([right], 2);
    players = [a, b];
    const html = render(compare, ["all", "1", "2"]);
    expect(html.includes("No shared statistics")).toBe(false);
    expect(html.includes("Total Shots")).toBe(outfield);
    expect(html.includes("Shots Faced")).toBe(keeper);
    expect(html).toContain("Highest Rating");
  });
}

test("monthly statistics, derived formulas and fractional balance are unchanged across position formats", async () => {
  let expected: Player["stats"] | undefined;
  for (const code of ["CM", "CF", "RWB", "LWB", "CF/ST", "CM/GK"]) {
    const p = await loadPositions([code]);
    expected ??= structuredClone(p.stats);
    expect(p.stats).toEqual(expected);
    expect(p.points).toBe(-1.25);
    const out = aggregateOutfield(p, "2026-06");
    expect([out.goals, out.assists, out.shots, out.shotsOnTarget, out.passes, out.passesCompleted,
      out.tackles, out.clearances, out.dribbles, out.keyPasses, out.chancesCreated,
      out.highestRating, out.lowestRating]).toEqual([2, 1, 8, 4, 9, 7, 6, 3, 2, 4, 5, 8.25, 7.5]);
    expect(out.passAccuracy).toBe(7 / 9 * 100);
  }
});

const estimates = [[1, 3, 2], [2, 5, 3], [3, 8, 5], [4, 10, 6], [5, 13, 8],
  [6, 15, 9], [7, 18, 11], [8, 20, 12], [9, 23, 14], [10, 25, 15], [11, 28, 17]];
for (const [goals, shots, onTarget] of estimates) {
  test(`June/July intentional shooting formula for ${goals} goals remains unchanged`, async () => {
    delete monthFields["SHOTS ttl - SOT"];
    monthFields["Goals"] = goals;
    const p = await loadPositions(["CF"]);
    for (const month of ["2026-06", "2026-07", "2026-08", "2026-09"] as const) {
      const subject = { ...p, stats: { [month]: p.stats["2026-06"]! } };
      const s = aggregateOutfield(subject, month);
      expect([s.shots, s.shotsOnTarget]).toEqual(month === "2026-06" || month === "2026-07" ? [shots, onTarget] : [0, 0]);
    }
  });
}

test("mixed-role exclusion, legacy shooting zero placeholders and measured-value precedence are preserved", async () => {
  for (const code of ["CF", "CF/GK", "CM/ST/GK", "GK"]) {
    for (const raw of [undefined, "0 - 0", "7 - 4"]) {
      monthFields["SHOTS ttl - SOT"] = raw;
      const p = await loadPositions([code]);
      const s = aggregateOutfield(p, "2026-06");
      expect([s.shots, s.shotsOnTarget]).toEqual(raw === "7 - 4" ? [7, 4] : p.playsKeeper ? [0, 0] : [5, 3]);
    }
  }
});

for (const category of ["potm", "scorer", "assists", "defender", "passing", "keeper"] as Category[]) {
  test(`${category}: existing games, rating and name tie-break order is preserved`, async () => {
    const base = await loadPositions(["CF/GK"]);
    const make = (id: string, games: number, rating: number): Player => ({
      ...base, id, name: id, stats: { "2026-06": { ...base.stats["2026-06"]!, gamesPlayed: games, highestRating: rating } },
    });
    const candidates = [make("D", 4, 10), make("C", 2, 7), make("B", 2, 8), make("A", 2, 8)];
    expect(leaderboard(category, "2026-06", candidates).map((p) => p.player.id))
      .toEqual(category === "potm" ? ["D", "A", "B", "C"] : ["A", "B", "C", "D"]);
  });
}
