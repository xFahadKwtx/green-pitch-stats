import type {
  KeeperMonthStats,
  KeeperPlayer,
  MonthKey,
  OutfieldMonthStats,
  OutfieldPlayer,
  Player,
} from "@/data/types";
import { MONTHS, isKeeper } from "@/data/types";

export type Period = MonthKey | "all";

const periodMonths = (period: Period): MonthKey[] =>
  period === "all" ? MONTHS : [period];

/** Weighted-by-games aggregation of outfield months. */
export function aggregateOutfield(
  player: OutfieldPlayer,
  period: Period,
): (OutfieldMonthStats & { passAccuracy: number }) | null {
  const rows = periodMonths(period)
    .map((m) => player.stats[m])
    .filter((r): r is OutfieldMonthStats => Boolean(r));
  if (rows.length === 0) return null;

  const sum = (pick: (r: OutfieldMonthStats) => number) =>
    rows.reduce((acc, r) => acc + pick(r), 0);

  const gamesPlayed = sum((r) => r.gamesPlayed);
  const passes = sum((r) => r.passes);
  const passesCompleted = sum((r) => r.passesCompleted);
  const ratingWeight = rows.reduce(
    (acc, r) => acc + r.avgRating * r.gamesPlayed,
    0,
  );

  return {
    gamesPlayed,
    mvpAwards: sum((r) => r.mvpAwards),
    goals: sum((r) => r.goals),
    assists: sum((r) => r.assists),
    shots: sum((r) => r.shots),
    shotsOnTarget: sum((r) => r.shotsOnTarget),
    passes,
    passesCompleted,
    tackles: sum((r) => r.tackles),
    clearances: sum((r) => r.clearances),
    dribbles: sum((r) => r.dribbles),
    keyPasses: sum((r) => r.keyPasses),
    chancesCreated: sum((r) => r.chancesCreated),
    avgRating: gamesPlayed ? ratingWeight / gamesPlayed : 0,
    highestRating: Math.max(...rows.map((r) => r.highestRating)),
    passAccuracy: passes ? (passesCompleted / passes) * 100 : 0,
  };
}

export function aggregateKeeper(
  player: KeeperPlayer,
  period: Period,
): (KeeperMonthStats & { savePercentage: number }) | null {
  const rows = periodMonths(period)
    .map((m) => player.stats[m])
    .filter((r): r is KeeperMonthStats => Boolean(r));
  if (rows.length === 0) return null;

  const sum = (pick: (r: KeeperMonthStats) => number) =>
    rows.reduce((acc, r) => acc + pick(r), 0);

  const gamesPlayed = sum((r) => r.gamesPlayed);
  const saves = sum((r) => r.saves);
  const shotsFaced = sum((r) => r.shotsFaced);
  const ratingWeight = rows.reduce(
    (acc, r) => acc + r.avgRating * r.gamesPlayed,
    0,
  );

  return {
    gamesPlayed,
    mvpAwards: sum((r) => r.mvpAwards),
    saves,
    shotsFaced,
    goalsConceded: sum((r) => r.goalsConceded),
    avgRating: gamesPlayed ? ratingWeight / gamesPlayed : 0,
    highestRating: Math.max(...rows.map((r) => r.highestRating)),
    savePercentage: shotsFaced ? (saves / shotsFaced) * 100 : 0,
  };
}

/** Common shape used by leaderboards for any player type. */
export interface UnifiedStats {
  player: Player;
  gamesPlayed: number;
  mvpAwards: number;
  goals: number;
  assists: number;
  tackles: number;
  passes: number;
  passAccuracy: number;
  savePercentage: number;
  avgRating: number;
  highestRating: number;
}

export function unifiedStats(period: Period, pool: Player[]): UnifiedStats[] {
  const rows: UnifiedStats[] = [];
  for (const player of pool) {
    if (isKeeper(player)) {
      const s = aggregateKeeper(player, period);
      if (!s) continue;
      rows.push({
        player,
        gamesPlayed: s.gamesPlayed,
        mvpAwards: s.mvpAwards,
        goals: 0,
        assists: 0,
        tackles: 0,
        passes: 0,
        passAccuracy: 0,
        savePercentage: s.savePercentage,
        avgRating: s.avgRating,
        highestRating: s.highestRating,
      });
    } else {
      const s = aggregateOutfield(player, period);
      if (!s) continue;
      rows.push({
        player,
        gamesPlayed: s.gamesPlayed,
        mvpAwards: s.mvpAwards,
        goals: s.goals,
        assists: s.assists,
        tackles: s.tackles,
        passes: s.passes,
        passAccuracy: s.passAccuracy,
        savePercentage: 0,
        avgRating: s.avgRating,
        highestRating: s.highestRating,
      });
    }
  }
  return rows;
}
