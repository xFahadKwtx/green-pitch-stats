import type { Match } from "@/data/types";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
// Booking dates/times are Kuwait wall time (Asia/Kuwait, UTC+3), not UTC inputs.
const KUWAIT_OFFSET_MS = 3 * 60 * MINUTE_MS;

/** A real YYYY-MM-DD calendar date, represented at nominal UTC midnight. */
export function parseBookingDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // setUTCFullYear avoids Date.UTC's special interpretation of years 00–99.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day ? date.getTime() : null;
}

/** Accept H:mm/HH:mm, optionally followed by AM/PM; return minutes after midnight. */
export function parseBookingTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = /^(\d{1,2}):(\d{2})(?:[ \t]*(AM|PM))?$/i.exec(value.trim());
  if (!parts) return null;
  let hour = Number(parts[1]);
  const minute = Number(parts[2]);
  const period = parts[3]?.toUpperCase();
  if (minute > 59) return null;
  if (period) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (period === "PM" ? 12 : 0);
  } else if (hour > 23) return null;
  return hour * 60 + minute;
}

/** Normalize only internal data; existing card/message formatters render 12-hour time. */
export function normalizeBooking(match: Match): Match | null {
  const date = parseBookingDate(match.date);
  const minutes = parseBookingTime(match.time);
  if (date === null || minutes === null) return null;
  return {
    ...match,
    date: match.date.trim(),
    time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
  };
}

function bookingStart(match: Match): number | null {
  const date = parseBookingDate(match.date);
  const minutes = parseBookingTime(match.time);
  return date === null || minutes === null ? null : date + minutes * MINUTE_MS - KUWAIT_OFFSET_MS;
}

/** Used only after validation; comparison never depends on the original time text. */
export function compareBookings(a: Match, b: Match): number {
  return bookingStart(a)! - bookingStart(b)!;
}

/** Inclusive Sunday midnight and exclusive following Sunday midnight, in Kuwait. */
export function kuwaitWeek(now: number): { start: number; end: number } {
  const local = new Date(now + KUWAIT_OFFSET_MS);
  const day = local.getUTCDay();
  local.setUTCHours(0, 0, 0, 0);
  const start = local.getTime() - day * DAY_MS - KUWAIT_OFFSET_MS;
  return { start, end: start + 7 * DAY_MS };
}

export function isBookingEligible(match: Match, now: number): boolean {
  const start = bookingStart(match);
  const week = kuwaitWeek(now);
  return start !== null && start > now && start >= week.start && start < week.end;
}

/** Recheck cached data without mutating it, including older unnormalized payloads. */
export function eligibleBookings(matches: Match[], now: number): Match[] {
  return matches
    .map(normalizeBooking)
    .filter((match): match is Match => match !== null && isBookingEligible(match, now))
    .sort(compareBookings);
}

/** One local wakeup at a booking start or week boundary, never a polling interval. */
export function nextBookingTransition(matches: Match[], now: number): number {
  let next = kuwaitWeek(now).end;
  for (const match of matches) {
    if (isBookingEligible(match, now)) next = Math.min(next, bookingStart(match)!);
  }
  return next;
}
