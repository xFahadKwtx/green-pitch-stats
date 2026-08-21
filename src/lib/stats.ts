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
 * Sums a statistic across months. Returns null (N/A) when the statistic is
 * missing in ANY included month — partial-period totals are never produced.
 */
function total(rows: MonthStats[], pick: (r: MonthStats) => StatValue): StatValue {
  if (rows.length === 0) return null;
  let sum = 0;
  for (const row of rows) {
    const value = pick(row);
    if (typeof value !== "number") return null;
    sum += value;
  }
  return sum;
}

/** Max across months; null when missing in any included month. */
function peak(rows: MonthStats[], pick: (r: MonthStats) => StatValue): StatValue {
  if (rows.length === 0) return null;
  let best: number | null = null;
  for (const row of rows) {
    const value = pick(row);
    if (typeof value !== "number") return null;
    best = best === null ? value : Math.max(best, value);
  }
  return best;
}

const ratio = (part: StatValue, whole: StatValue): StatValue =>
  typeof part === "number" && typeof whole === "number" && whole > 0
    ? (part / whole) * 100
    : null;

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

export function aggregateOutfield(
  player: Player,
  period: Period,
): OutfieldAggregate | null {
  const months = recordedMonths(player, period);
  if (months.length === 0) return null;
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
    avgRating: null, // no true average-rating field exists in Airtable
    highestRating: peak(rows, (r) => r.highestRating),
  };
}

export function aggregateKeeper(player: Player, period: Period): KeeperAggregate | null {
  if (!player.playsKeeper) return null;
  const months = keeperMonths(player, period);
  if (months.length === 0) return null;
  const rows = months.map((m) => player.stats[m]!);

  const saves = total(rows, (r) => r.saves);
  const shotsFaced = total(rows, (r) => r.shotsFaced);
  const conceded =
    typeof saves === "number" && typeof shotsFaced === "number"
      ? Math.max(shotsFaced - saves, 0)
      : null;

  return {
    months,
    gamesPlayed: total(rows, (r) => r.gamesPlayed),
    mvpAwards: total(rows, (r) => r.mvpAwards),
    saves,
    shotsFaced,
    goalsConceded: conceded,
    savePercentage: ratio(saves, shotsFaced),
    avgRating: null,
    highestRating: peak(rows, (r) => r.highestRating),
  };
}
