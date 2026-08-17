import { players } from "@/data/players";
import { isKeeper } from "@/data/types";
import { unifiedStats, type Period, type UnifiedStats } from "./stats";

export type Category =
  | "potm"
  | "scorer"
  | "assists"
  | "defender"
  | "passing"
  | "keeper";

const cmp = (...tiebreakers: ((a: UnifiedStats, b: UnifiedStats) => number)[]) =>
  (a: UnifiedStats, b: UnifiedStats) => {
    for (const fn of tiebreakers) {
      const r = fn(a, b);
      if (r !== 0) return r;
    }
    return a.player.name.localeCompare(b.player.name);
  };

const desc = (pick: (s: UnifiedStats) => number) => (a: UnifiedStats, b: UnifiedStats) =>
  pick(b) - pick(a);
const asc = (pick: (s: UnifiedStats) => number) => (a: UnifiedStats, b: UnifiedStats) =>
  pick(a) - pick(b);

const games = (s: UnifiedStats) => s.gamesPlayed;
const rating = (s: UnifiedStats) => s.highestRating;

export function leaderboard(category: Category, period: Period): UnifiedStats[] {
  const outfielders = players.filter((p) => !isKeeper(p));
  const keepers = players.filter(isKeeper);

  switch (category) {
    case "potm":
      return unifiedStats(period, players).sort(
        cmp(desc((s) => s.mvpAwards), desc(games), desc(rating)),
      );
    case "scorer":
      return unifiedStats(period, outfielders).sort(
        cmp(
          desc((s) => s.goals),
          asc(games),
          desc((s) => s.assists),
          desc(rating),
        ),
      );
    case "assists":
      return unifiedStats(period, outfielders).sort(
        cmp(
          desc((s) => s.assists),
          asc(games),
          desc((s) => s.goals),
          desc(rating),
        ),
      );
    case "defender":
      return unifiedStats(period, outfielders).sort(
        cmp(desc((s) => s.tackles), asc(games), desc(rating)),
      );
    case "passing":
      return unifiedStats(period, outfielders).sort(
        cmp(desc((s) => s.passAccuracy), asc(games), desc(rating)),
      );
    case "keeper":
      return unifiedStats(period, keepers).sort(
        cmp(desc((s) => s.savePercentage), asc(games), desc(rating)),
      );
  }
}
