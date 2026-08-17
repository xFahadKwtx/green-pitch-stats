/**
 * Domain types. UI never builds these itself — data comes from this layer only,
 * so it can be swapped for a database/API later without touching components.
 */

export type MonthKey = "2026-06" | "2026-07" | "2026-08";

export const MONTHS: MonthKey[] = ["2026-06", "2026-07", "2026-08"];

export type Position = "GK" | "DEF" | "MID" | "FWD";

export interface OutfieldMonthStats {
  gamesPlayed: number;
  mvpAwards: number;
  goals: number;
  assists: number;
  shots: number;
  shotsOnTarget: number;
  passes: number;
  passesCompleted: number;
  tackles: number;
  clearances: number;
  dribbles: number;
  keyPasses: number;
  chancesCreated: number;
  avgRating: number;
  highestRating: number;
}

export interface KeeperMonthStats {
  gamesPlayed: number;
  mvpAwards: number;
  saves: number;
  shotsFaced: number;
  goalsConceded: number;
  avgRating: number;
  highestRating: number;
}

export interface PlayerBase {
  id: string;
  name: string;
  nameAr: string;
  position: Position;
  points: number;
}

export interface OutfieldPlayer extends PlayerBase {
  position: "DEF" | "MID" | "FWD";
  stats: Partial<Record<MonthKey, OutfieldMonthStats>>;
}

export interface KeeperPlayer extends PlayerBase {
  position: "GK";
  stats: Partial<Record<MonthKey, KeeperMonthStats>>;
}

export type Player = OutfieldPlayer | KeeperPlayer;

export const isKeeper = (p: Player): p is KeeperPlayer => p.position === "GK";

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
