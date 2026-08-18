/**
 * Maps the Airtable base (read-only) onto the app's domain types.
 * Airtable is never written to — see airtable.server.ts.
 */
import type {
  KeeperMonthStats,
  KeeperPlayer,
  MonthKey,
  OutfieldMonthStats,
  OutfieldPlayer,
  Player,
  Position,
} from "@/data/types";

import {
  AIRTABLE_TABLES,
  listAirtableRecords,
  numeric,
  pair,
  selects,
  str,
  type AirtableRecord,
} from "./airtable.server";

const MONTH_TABLES: Record<MonthKey, string> = {
  "2026-06": AIRTABLE_TABLES.statsJune,
  "2026-07": AIRTABLE_TABLES.statsJuly,
  "2026-08": AIRTABLE_TABLES.statsAugust,
};

const POSITION_GROUP: Record<string, Position> = {
  GK: "GK",
  CB: "DEF",
  RB: "DEF",
  LB: "DEF",
  DEF: "DEF",
  CDM: "MID",
  CM: "MID",
  CAM: "MID",
  RM: "MID",
  LM: "MID",
  MID: "MID",
  ST: "FWD",
  LW: "FWD",
  RW: "FWD",
  FWD: "FWD",
};

function resolvePosition(raw: string[]): Position {
  for (const tag of raw) {
    const group = POSITION_GROUP[tag.trim().toUpperCase()];
    if (group) return group;
  }
  return "MID";
}

const avgOf = (low: number, high: number): number => {
  if (low && high) return (low + high) / 2;
  return high || low || 0;
};

function outfieldStats(fields: Record<string, unknown>): OutfieldMonthStats {
  const [passes, passesCompleted] = pair(fields["Passes"]);
  const [shots, shotsOnTarget] = pair(fields["SHOTS ttl - SOT"]);
  const mvp = numeric(fields["MVP"]) || (fields["POTM"] === true ? 1 : 0);
  const high = numeric(fields["Highest Rating"]);
  const low = numeric(fields["Lowest Rating"]);
  const keyPasses = numeric(fields["KeyPasses"]);

  return {
    gamesPlayed: numeric(fields["Games played"]),
    mvpAwards: mvp,
    goals: numeric(fields["Goals"]),
    assists: numeric(fields["Assists"]),
    shots,
    shotsOnTarget,
    passes,
    passesCompleted,
    tackles: numeric(fields["Tackles"]),
    clearances: numeric(fields["Clearences"]),
    dribbles: 0,
    keyPasses,
    chancesCreated: keyPasses,
    avgRating: avgOf(low, high),
    highestRating: high,
  };
}

function keeperStats(fields: Record<string, unknown>): KeeperMonthStats {
  const [shotsFaced, saves] = pair(fields["GK saves"]);
  const high = numeric(fields["Highest Rating"]);
  const low = numeric(fields["Lowest Rating"]);

  return {
    gamesPlayed: numeric(fields["Games played"]),
    mvpAwards: numeric(fields["MVP"]) || (fields["POTM"] === true ? 1 : 0),
    saves,
    shotsFaced,
    goalsConceded: Math.max(shotsFaced - saves, 0),
    avgRating: avgOf(low, high),
    highestRating: high,
  };
}

const hasAnyValue = (fields: Record<string, unknown>): boolean =>
  numeric(fields["Games played"]) > 0 ||
  numeric(fields["Goals"]) > 0 ||
  numeric(fields["Assists"]) > 0 ||
  str(fields["Passes"]) !== "" ||
  str(fields["GK saves"]) !== "";

const keyOf = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** Reads every website-visible player plus their monthly stats from Airtable. */
export async function fetchPlayersFromAirtable(): Promise<Player[]> {
  const [playerRows, ...monthRows] = await Promise.all([
    listAirtableRecords(AIRTABLE_TABLES.playersDatabase),
    ...(Object.keys(MONTH_TABLES) as MonthKey[]).map((month) =>
      listAirtableRecords(MONTH_TABLES[month]),
    ),
  ]);

  const months = Object.keys(MONTH_TABLES) as MonthKey[];
  const statsByMonth = new Map<MonthKey, Map<string, AirtableRecord>>();
  months.forEach((month, index) => {
    const map = new Map<string, AirtableRecord>();
    for (const record of monthRows[index] ?? []) {
      const name = str(record.fields["Name"]);
      if (name) map.set(keyOf(name), record);
    }
    statsByMonth.set(month, map);
  });

  const players: Player[] = [];

  for (const record of playerRows) {
    if (record.fields["Show On Website"] !== true) continue;

    const nameAr = str(record.fields["Official Name AR"]) || str(record.fields["Name"]);
    const name = str(record.fields["Official Name EN"]) || nameAr;
    if (!name && !nameAr) continue;

    const id = str(record.fields["Player ID"]) || record.id;
    const position = resolvePosition(selects(record.fields["Position"]));
    const points = numeric(record.fields["Points Balance"]);
    const lookupKeys = [nameAr, str(record.fields["Name"]), name]
      .filter(Boolean)
      .map(keyOf);

    if (position === "GK") {
      const stats: KeeperPlayer["stats"] = {};
      for (const month of months) {
        const map = statsByMonth.get(month)!;
        const row = lookupKeys.map((k) => map.get(k)).find(Boolean);
        if (row && hasAnyValue(row.fields)) stats[month] = keeperStats(row.fields);
      }
      players.push({ id, name, nameAr, position: "GK", points, stats });
    } else {
      const stats: OutfieldPlayer["stats"] = {};
      for (const month of months) {
        const map = statsByMonth.get(month)!;
        const row = lookupKeys.map((k) => map.get(k)).find(Boolean);
        if (row && hasAnyValue(row.fields)) stats[month] = outfieldStats(row.fields);
      }
      players.push({ id, name, nameAr, position, points, stats });
    }
  }

  return players.sort((a, b) => a.name.localeCompare(b.name));
}
