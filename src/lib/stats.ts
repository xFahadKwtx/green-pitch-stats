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
  highestRating: StatValue;
  lowestRating: StatValue;
}

export interface KeeperAggregate {
  months: MonthKey[];
  gamesPlayed: StatValue;
  mvpAwards: StatValue;
  saves: StatValue;
  shotsFaced: StatValue;
  goalsConceded: StatValue;
  savePercentage: StatValue;
  highestRating: StatValue;
  lowestRating: StatValue;
}

/**
 * JUNE and JULY have no recorded shooting statistics in Airtable, so a 0 there
 * means "not recorded". For outfield players with at least one goal we show an
 * estimate instead. Language-independent: this is pure data logic.
 * If real values ever appear for those months, they take priority.
 */
const ESTIMATED_MONTHS = new Set<MonthKey>(["2026-06", "2026-07"]);

const SHOT_MAP: Record<number, [number, number]> = {
  1: [3, 2],
  2: [5, 3],
  3: [8, 5],
  4: [10, 6],
  5: [13, 8],
  6: [15, 9],
  7: [18, 11],
  8: [20, 12],
  9: [23, 14],
  10: [25, 15],
};

/** Effective [shots, shotsOnTarget] for one month of a player's stats. */
function effectiveShots(
  player: Player,
  month: MonthKey,
  row: MonthStats,
): [number, number] {
  const shots = row.shots ?? 0;
  const sot = row.shotsOnTarget ?? 0;

  const needsEstimate =
    ESTIMATED_MONTHS.has(month) &&
    player.playsOutfield &&
    !player.playsKeeper &&
    shots === 0 &&
    sot === 0;

  const goals = row.goals ?? 0;
  if (!needsEstimate || goals < 1) return [shots, sot];

  const mapped = SHOT_MAP[goals];
  let estShots: number;
  let estSot: number;
  if (mapped) {
    [estShots, estSot] = mapped;
  } else {
    estShots = Math.round(goals * 2.5);
    estSot = Math.round(estShots * 0.6);
  }

  estSot = Math.max(estSot, goals);
  estShots = Math.max(estShots, estSot);
  return [estShots, estSot];
}

export function aggregateOutfield(player: Player, period: Period): OutfieldAggregate {
  const months = recordedMonths(player, period);
  const rows = months.map((m) => player.stats[m]!);

  const passes = total(rows, (r) => r.passes);
  const passesCompleted = total(rows, (r) => r.passesCompleted);

  let shots = 0;
  let shotsOnTarget = 0;
  months.forEach((month, index) => {
    const [s, sot] = effectiveShots(player, month, rows[index]!);
    shots += s;
    shotsOnTarget += sot;
  });

  return {
    months,
    gamesPlayed: total(rows, (r) => r.gamesPlayed),
    mvpAwards: total(rows, (r) => r.mvpAwards),
    goals: total(rows, (r) => r.goals),
    assists: total(rows, (r) => r.assists),
    shots,
    shotsOnTarget,

    passes,
    passesCompleted,
    passAccuracy: ratio(passesCompleted, passes),
    tackles: total(rows, (r) => r.tackles),
    clearances: total(rows, (r) => r.clearances),
    dribbles: total(rows, (r) => r.dribbles),
    keyPasses: total(rows, (r) => r.keyPasses),
    // Derived, never entered manually: per-month Assists + Key Passes.
    chancesCreated: total(
      rows,
      (r) => (r.assists ?? 0) + (r.keyPasses ?? 0),
    ),
    highestRating: peak(rows, (r) => r.highestRating),
    lowestRating: trough(rows, (r) => r.lowestRating),
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
    highestRating: peak(rows, (r) => r.highestRating),
    lowestRating: trough(rows, (r) => r.lowestRating),
  };
}

