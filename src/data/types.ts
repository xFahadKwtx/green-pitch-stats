/**
 * Domain types. UI never builds these itself — data comes from the Airtable
 * data layer only.
 *
 * IMPORTANT: every statistic is `number | null`. `null` means "not recorded in
 * Airtable" and must be rendered as N/A — never as 0. Only a real Airtable 0 is
 * shown as 0.
 */

export type MonthKey = "2026-06" | "2026-07" | "2026-08";

export const MONTHS: MonthKey[] = ["2026-06", "2026-07", "2026-08"];

/** Coarse grouping used for display/sorting only. */
export type Position = "GK" | "DEF" | "MID" | "FWD";

export type StatValue = number | null;

/** One month of Airtable statistics for a single player. */
export interface MonthStats {
  gamesPlayed: StatValue;
  mvpAwards: StatValue;
  /** Outfield */
  goals: StatValue;
  assists: StatValue;
  shots: StatValue;
  shotsOnTarget: StatValue;
  /** "Passes" = total - completed */
  passes: StatValue;
  passesCompleted: StatValue;
  tackles: StatValue;
  clearances: StatValue;
  dribbles: StatValue;
  keyPasses: StatValue;
  chancesCreated: StatValue;
  /** Goalkeeper — "GK saves" = shots faced - saves */
  shotsFaced: StatValue;
  saves: StatValue;
  /** Ratings */
  highestRating: StatValue;
  lowestRating: StatValue;
}

export interface Player {
  /** Airtable "Player ID" (stable identifier). */
  id: string;
  /** Official Name EN */
  name: string;
  /** Official Name AR */
  nameAr: string;
  /** Raw Airtable positions, e.g. ["CM", "GK"]. */
  positions: string[];
  /** Coarse group derived from `positions`. */
  positionGroup: Position;
  playsKeeper: boolean;
  playsOutfield: boolean;
  /** Points Balance */
  points: StatValue;
  /** Last 5 Results from the master table (oldest → newest, left → right). */
  last5Results: Array<"W" | "L" | "D" | null>;
  stats: Partial<Record<MonthKey, MonthStats>>;
}

export interface Match {
  id: string;
  /** ISO date, e.g. 2026-08-23 */
  date: string;
  /** 24h time, e.g. 22:00 */
  time: string;
  location: string;
  locationAr: string;
  spotsLeft?: number;
}

export interface Announcement {
  id: string;
  title: string;
  titleAr: string;
  body: string;
  bodyAr: string;
  tag: string;
  tagAr: string;
  ctaLabel?: string;
  ctaLabelAr?: string;
  ctaHref?: string;
}

export interface StoreProduct {
  id: string;
  name: string;
  nameAr: string;
  price: number;
  currency: string;
  imageUrl?: string;
  inStock: boolean;
}

export interface PositionChallenge {
  position: Position;
  challenge: string;
  challengeAr: string;
}
