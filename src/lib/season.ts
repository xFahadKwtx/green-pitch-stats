/**
 * The home page banner names the season after the month that is currently
 * running in Kuwait (Asia/Kuwait, UTC+3 all year — no daylight saving).
 *
 * This module is pure: no timers, no I/O and no randomness at module scope, so
 * it is safe both during SSR and inside the deployed worker.
 */

export const KUWAIT_TIME_ZONE = "Asia/Kuwait";

/** English month names, January first. */
export const MONTH_NAMES_EN: readonly string[] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Arabic month names, يناير first — the same names the site already uses. */
export const MONTH_NAMES_AR: readonly string[] = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

const KUWAIT_OFFSET_MS = 3 * 60 * 60 * 1000;

let kuwaitMonthFormatter: Intl.DateTimeFormat | undefined;

/** 0-based month index (January = 0) of `now` as seen in Kuwait. */
export function kuwaitMonthIndex(now: Date): number {
  try {
    kuwaitMonthFormatter ??= new Intl.DateTimeFormat("en-US", {
      timeZone: KUWAIT_TIME_ZONE,
      month: "numeric",
    });
    const month = kuwaitMonthFormatter
      .formatToParts(now)
      .find((part) => part.type === "month")?.value;
    const index = Number(month) - 1;
    if (Number.isInteger(index) && index >= 0 && index <= 11) return index;
  } catch {
    // Runtime without IANA time-zone data: fall back to the fixed UTC+3 offset.
  }
  return new Date(now.getTime() + KUWAIT_OFFSET_MS).getUTCMonth();
}

/** e.g. "NOVEMBER SEASON IS LIVE" */
export function seasonTitleEn(now: Date): string {
  const name = MONTH_NAMES_EN[kuwaitMonthIndex(now)] ?? "";
  return `${name.toUpperCase()} SEASON IS LIVE`;
}

/** e.g. "موسم نوفمبر انطلق" */
export function seasonTitleAr(now: Date): string {
  return `موسم ${MONTH_NAMES_AR[kuwaitMonthIndex(now)] ?? ""} انطلق`;
}
