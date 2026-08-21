import type { MonthKey, MonthStats, Player, StatValue } from "@/data/types";
import { MONTHS } from "@/data/types";

export type Period = MonthKey | "all";

/** Months included for this player: for "all", only the months they played. */
export function recordedMonths(player: Player, period: Period): MonthKey[] {
  const candidates = period === "all" ? MONTHS : [period];
  return candidates.filter((m) => Boolean(player.stats[m]));
}

/** Months where this player actually has goalkeeper data (GK saves). */
export function keeperMonths(player: Player, period: Period): MonthKey[] {
  return recordedMonths(player, period).filter((m) => {
    const s = player.stats[m]!;
    return typeof s.saves === "number" && typeof s.shotsFaced === "number";
  });
}

/**
 * Sums a statistic across months. Missing values contribute 0, so a period
 * total always reflects whatever was actually recorded.
 */
function total(rows: MonthStats[], pick: (r: MonthStats) => StatValue): number {
  let sum = 0;
  for (const row of rows) {
    const value = pick(row);
    if (typeof value === "number") sum += value;
  }
  return sum;
}

/** Max across months; 0 when nothing was recorded. */
function peak(rows: MonthStats[], pick: (r: MonthStats) => StatValue): number {
  let best = 0;
  for (const row of rows) {
    const value = pick(row);
    if (typeof value === "number") best = Math.max(best, value);
  }
  return best;
}

/** Min across recorded months; 0 when nothing was recorded. */
function trough(rows: MonthStats[], pick: (r: MonthStats) => StatValue): number {
  let low: number | null = null;
  for (const row of rows) {
    const value = pick(row);
    if (typeof value === "number") low = low === null ? value : Math.min(low, value);
  }
  return low ?? 0;
}

const ratio = (part: number, whole: number): number =>
  whole > 0 ? (part / whole) * 100 : 0;


export interface OutfieldAggregate {
  months: MonthKey[];
  gamesPlayed: StatValue;
  mvpAwards: StatValue;
  goals: StatValue;
  assists: StatValue;
  shots: StatValue;
  shotsOnTarget: StatValue;
  passes: StatValue;
  passesCompleted: StatValue;
  passAccuracy: StatValue;
  tackles: StatValue;
  clearances: StatValue;
  dribbles: StatValue;
  keyPasses: StatValue;
  chancesCreated: StatValue;
  avgRating: StatValue;
  highestRating: StatValue;
}

export interface KeeperAggregate {
  months: MonthKey[];
  gamesPlayed: StatValue;
  mvpAwards: StatValue;
  saves: StatValue;
  shotsFaced: StatValue;
  goalsConceded: StatValue;
  savePercentage: StatValue;
  avgRating: StatValue;
  highestRating: StatValue;
}

export function aggregateOutfield(player: Player, period: Period): OutfieldAggregate {
  const months = recordedMonths(player, period);
  const rows = months.map((m) => player.stats[m]!);

  const passes = total(rows, (r) => r.passes);
  const passesCompleted = total(rows, (r) => r.passesCompleted);

  return {
    months,
    gamesPlayed: total(rows, (r) => r.gamesPlayed),
    mvpAwards: total(rows, (r) => r.mvpAwards),
    goals: total(rows, (r) => r.goals),
    assists: total(rows, (r) => r.assists),
    shots: total(rows, (r) => r.shots),
    shotsOnTarget: total(rows, (r) => r.shotsOnTarget),
    passes,
    passesCompleted,
    passAccuracy: ratio(passesCompleted, passes),
    tackles: total(rows, (r) => r.tackles),
    clearances: total(rows, (r) => r.clearances),
    dribbles: total(rows, (r) => r.dribbles),
    keyPasses: total(rows, (r) => r.keyPasses),
    chancesCreated: total(rows, (r) => r.chancesCreated),
    avgRating: total(rows, (r) => r.avgRating),
    highestRating: peak(rows, (r) => r.highestRating),
  };
}

export function aggregateKeeper(player: Player, period: Period): KeeperAggregate | null {
  if (!player.playsKeeper) return null;
  const months = recordedMonths(player, period);
  const rows = months.map((m) => player.stats[m]!);

  const saves = total(rows, (r) => r.saves);
  const shotsFaced = total(rows, (r) => r.shotsFaced);

  return {
    months,
    gamesPlayed: total(rows, (r) => r.gamesPlayed),
    mvpAwards: total(rows, (r) => r.mvpAwards),
    saves,
    shotsFaced,
    goalsConceded: Math.max(shotsFaced - saves, 0),
    savePercentage: ratio(saves, shotsFaced),
    avgRating: total(rows, (r) => r.avgRating),
    highestRating: peak(rows, (r) => r.highestRating),
  };
}

