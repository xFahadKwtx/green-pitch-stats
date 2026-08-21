import type { Player, StatValue } from "@/data/types";
import { aggregateKeeper, aggregateOutfield, type Period } from "./stats";

export type Category =
  | "potm"
  | "scorer"
  | "assists"
  | "defender"
  | "passing"
  | "keeper";

export interface LeaderRow {
  player: Player;
  gamesPlayed: StatValue;
  mvpAwards: StatValue;
  goals: StatValue;
  assists: StatValue;
  tackles: StatValue;
  passes: StatValue;
  passAccuracy: StatValue;
  savePercentage: StatValue;
  highestRating: StatValue;
}

const HIGH = (v: StatValue) => (typeof v === "number" ? v : -Infinity);
const LOW = (v: StatValue) => (typeof v === "number" ? v : Infinity);

const most = (pick: (r: LeaderRow) => StatValue) => (a: LeaderRow, b: LeaderRow) =>
  HIGH(pick(b)) - HIGH(pick(a));
const fewest = (pick: (r: LeaderRow) => StatValue) => (a: LeaderRow, b: LeaderRow) =>
  LOW(pick(a)) - LOW(pick(b));

const games = (r: LeaderRow) => r.gamesPlayed;
const rating = (r: LeaderRow) => r.highestRating;

const order =
  (...tiebreakers: ((a: LeaderRow, b: LeaderRow) => number)[]) =>
  (a: LeaderRow, b: LeaderRow) => {
    for (const fn of tiebreakers) {
      const result = fn(a, b);
      if (result !== 0) return result;
    }
    return a.player.name.localeCompare(b.player.name);
  };

/** Role-agnostic + goalkeeper rows for one period. */
function rowsFor(players: Player[], period: Period): LeaderRow[] {
  const rows: LeaderRow[] = [];
  for (const player of players) {
    const out = aggregateOutfield(player, period);
    const gk = aggregateKeeper(player, period);
    if (!out && !gk) continue;
    rows.push({
      player,
      gamesPlayed: out?.gamesPlayed ?? gk?.gamesPlayed ?? null,
      mvpAwards: out?.mvpAwards ?? gk?.mvpAwards ?? null,
      goals: out?.goals ?? null,
      assists: out?.assists ?? null,
      tackles: out?.tackles ?? null,
      passes: out?.passes ?? null,
      passAccuracy: out?.passAccuracy ?? null,
      savePercentage: gk?.savePercentage ?? null,
      highestRating: out?.highestRating ?? gk?.highestRating ?? null,
    });
  }
  return rows;
}

const recorded = (pick: (r: LeaderRow) => StatValue) => (r: LeaderRow) =>
  typeof pick(r) === "number";

export function leaderboard(
  category: Category,
  period: Period,
  players: Player[],
): LeaderRow[] {
  const all = rowsFor(players, period);
  const outfield = all.filter((r) => r.player.playsOutfield);

  switch (category) {
    case "potm":
      return all
        .filter(recorded((r) => r.mvpAwards))
        .sort(order(most((r) => r.mvpAwards), most(games), most(rating)));
    case "scorer":
      return outfield
        .filter(recorded((r) => r.goals))
        .sort(
          order(
            most((r) => r.goals),
            fewest(games),
            most((r) => r.assists),
            most(rating),
          ),
        );
    case "assists":
      return outfield
        .filter(recorded((r) => r.assists))
        .sort(
          order(
            most((r) => r.assists),
            fewest(games),
            most((r) => r.goals),
            most(rating),
          ),
        );
    case "defender":
      return outfield
        .filter(recorded((r) => r.tackles))
        .sort(order(most((r) => r.tackles), fewest(games), most(rating)));
    case "passing":
      return outfield
        .filter(recorded((r) => r.passAccuracy))
        .sort(order(most((r) => r.passAccuracy), fewest(games), most(rating)));
    case "keeper":
      return all
        .filter((r) => r.player.playsKeeper)
        .filter(recorded((r) => r.savePercentage))
        .sort(order(most((r) => r.savePercentage), fewest(games), most(rating)));
  }
}
