/**
 * Maps the Airtable base (read-only) onto the app's domain types.
 * Airtable is never written to — see airtable.server.ts.
 *
 * Rules honoured here:
 * - Only `Show On Website` players are returned.
 * - Public names come from Official Name EN / Official Name AR (never `Name`).
 * - Monthly stats are matched through the Airtable linked record, never names.
 * - A missing Airtable cell becomes `null` (rendered as N/A), never 0.
 */
import type { MonthKey, MonthStats, Player, Position } from "@/data/types";

import {
  AIRTABLE_TABLES,
  linkedRecordIds,
  listAirtableRecords,
  optNumeric,
  optPair,
  selects,
  str,
} from "./airtable.server";

const MONTH_TABLES: Record<MonthKey, string> = {
  "2026-06": AIRTABLE_TABLES.statsJune,
  "2026-07": AIRTABLE_TABLES.statsJuly,
  "2026-08": AIRTABLE_TABLES.statsAugust,
  "2026-09": AIRTABLE_TABLES.statsSeptember,
};

const OUTFIELD_GROUP: Record<string, Position> = {
  CB: "DEF",
  RB: "DEF",
  LB: "DEF",
  RWB: "DEF",
  LWB: "DEF",
  DEF: "DEF",
  CDM: "MID",
  CM: "MID",
  CAM: "MID",
  RM: "MID",
  LM: "MID",
  MID: "MID",
  ST: "FWD",
  CF: "FWD",
  LW: "FWD",
  RW: "FWD",
  FWD: "FWD",
};

function groupOf(positions: string[]): Position {
  for (const tag of positions) {
    const group = OUTFIELD_GROUP[tag];
    if (group) return group;
  }
  return positions.includes("GK") ? "GK" : "MID";
}

/** Parses the "Last 5 Results" field into a fixed 5-item sequence. */
function parseLast5Results(value: unknown): Array<"W" | "L" | "D" | null> {
  const text = str(value);
  if (!text) return [null, null, null, null, null];

  const results: Array<"W" | "L" | "D" | null> = [];
  for (const raw of text.split("-")) {
    const token = raw.trim().toUpperCase();
    if (token === "W" || token === "L" || token === "D") {
      results.push(token);
    } else if (token === "") {
      results.push(null);
    }
    if (results.length === 5) break;
  }

  while (results.length < 5) results.push(null);
  return results.slice(0, 5);
}

/** Builds one month of stats. Absent Airtable cells stay null (N/A). */
function monthStats(fields: Record<string, unknown>): MonthStats {
  const [passes, passesCompleted] = optPair(fields["Passes"]);
  const [shots, shotsOnTarget] = optPair(fields["SHOTS ttl - SOT"]);
  const [shotsFaced, saves] = optPair(fields["GK saves"]);

  // MVP is a per-month counter kept for every month: a blank cell on a played
  // month means zero awards (confirmed by the base owner).
  const mvpRaw = optNumeric(fields["MVP"]);
  const mvpAwards = mvpRaw ?? (fields["POTM"] === true ? 1 : 0);

  return {
    gamesPlayed: optNumeric(fields["Games played"]),
    mvpAwards,
    goals: optNumeric(fields["Goals"]),
    assists: optNumeric(fields["Assists"]),
    shots,
    shotsOnTarget,
    passes,
    passesCompleted,
    tackles: optNumeric(fields["Tackles"]),
    clearances: optNumeric(fields["Clearences"]),
    // Not present anywhere in the base yet — always N/A until the fields exist.
    dribbles: optNumeric(fields["Successful Dribbles"]),
    keyPasses: optNumeric(fields["KeyPasses"]),
    chancesCreated: optNumeric(fields["Chances Created"]),
    shotsFaced,
    saves,
    highestRating: optNumeric(fields["Highest Rating"]),
    lowestRating: optNumeric(fields["Lowest Rating"]),
  };
}

/** True when the record holds at least one recorded value. */
const hasAnyValue = (s: MonthStats): boolean =>
  Object.entries(s).some(
    ([key, value]) => key !== "mvpAwards" && typeof value === "number",
  );

/** Reads every website-visible player plus their monthly stats from Airtable. */
export async function fetchPlayersFromAirtable(): Promise<Player[]> {
  const months = Object.keys(MONTH_TABLES) as MonthKey[];

  const [playerRows, ...monthRows] = await Promise.all([
    listAirtableRecords(AIRTABLE_TABLES.playersDatabase),
    ...months.map((month) => listAirtableRecords(MONTH_TABLES[month])),
  ]);

  /** month -> Airtable player record id -> stats */
  const statsByMonth = new Map<MonthKey, Map<string, MonthStats>>();
  months.forEach((month, index) => {
    const map = new Map<string, MonthStats>();
    for (const record of monthRows[index] ?? []) {
      const stats = monthStats(record.fields);
      if (!hasAnyValue(stats)) continue;
      for (const playerRecordId of new Set(linkedRecordIds(record.fields))) {
        map.set(playerRecordId, stats);
      }
    }
    statsByMonth.set(month, map);
  });

  const players: Player[] = [];

  for (const record of playerRows) {
    if (record.fields["Show On Website"] !== true) continue;

    const name = str(record.fields["Official Name EN"]);
    const nameAr = str(record.fields["Official Name AR"]);
    if (!name && !nameAr) continue;

    const positions = selects(record.fields["Position"])
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean);
    // Match directory separators while preserving the original display entries.
    const positionTokens = positions
      .flatMap((p) => p.split(/[•\-/,\s]+/))
      .filter(Boolean);

    const stats: Player["stats"] = {};
    for (const month of months) {
      const row = statsByMonth.get(month)!.get(record.id);
      if (row) stats[month] = row;
    }

    players.push({
      id: str(record.fields["Player ID"]) || record.id,
      name: name || nameAr,
      nameAr: nameAr || name,
      positions,
      positionGroup: groupOf(positionTokens),
      playsKeeper: positionTokens.includes("GK"),
      playsOutfield: positionTokens.some((p) => p !== "GK" && OUTFIELD_GROUP[p] !== undefined),
      points: optNumeric(record.fields["Points Balance"]),
      last5Results: parseLast5Results(record.fields["Last 5 Results"]),
      stats,
    });
  }

  return players.sort((a, b) => a.name.localeCompare(b.name));
}
