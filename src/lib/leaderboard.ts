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

/** Role-agnostic + goalkeeper rows for one period. Missing values count as 0. */
function rowsFor(players: Player[], period: Period): LeaderRow[] {
  const rows: LeaderRow[] = [];
  for (const player of players) {
    const months = recordedMonths(player, period);
    if (months.length === 0) continue;
    const out = aggregateOutfield(player, period);
    const gk = aggregateKeeper(player, period);
    rows.push({
      player,
      gamesPlayed: out.gamesPlayed,
      mvpAwards: out.mvpAwards,
      goals: out.goals,
      assists: out.assists,
      tackles: out.tackles,
      passes: out.passes,
      passAccuracy: out.passAccuracy,
      savePercentage: gk?.savePercentage ?? 0,
      highestRating: out.highestRating,
    });
  }
  return rows;
}

export function leaderboard(
  category: Category,
  period: Period,
  players: Player[],
): LeaderRow[] {
  const all = rowsFor(players, period);
  const outfield = all.filter((r) => r.player.playsOutfield);

  switch (category) {
    case "potm":
      return all.sort(order(most((r) => r.mvpAwards), most(games), most(rating)));
    case "scorer":
      return outfield.sort(
        order(
          most((r) => r.goals),
          fewest(games),
          most((r) => r.assists),
          most(rating),
        ),
      );
    case "assists":
      return outfield.sort(
        order(
          most((r) => r.assists),
          fewest(games),
          most((r) => r.goals),
          most(rating),
        ),
      );
    case "defender":
      return outfield.sort(order(most((r) => r.tackles), fewest(games), most(rating)));
    case "passing":
      return outfield.sort(order(most((r) => r.passAccuracy), fewest(games), most(rating)));
    case "keeper":
      return all
        .filter((r) => r.player.playsKeeper)
        .sort(order(most((r) => r.savePercentage), fewest(games), most(rating)));
  }
}

