import type { Match } from "@/data/types";
import type { Lang } from "./i18n";

export const localeOf = (lang: Lang) => (lang === "ar" ? "ar-KW" : "en-GB");

export function dayName(iso: string, lang: Lang) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(localeOf(lang), {
    weekday: "long",
  });
}

export function longDate(iso: string, lang: Lang) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(localeOf(lang), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function prettyTime(time: string, _lang: Lang) {
  const normalized = time.trim().toUpperCase();
  const amPmMatch = normalized.match(/^(\d{1,2}):(\d{2})\s?(AM|PM)$/);

  let h = 0;
  let m = 0;

  if (amPmMatch) {
    let hour = Number(amPmMatch[1]);
    const minute = Number(amPmMatch[2]);
    const period = amPmMatch[3];
    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    h = hour;
    m = minute;
  } else {
    const [hour, minute] = time.split(":").map(Number);
    h = hour ?? 0;
    m = minute ?? 0;
  }

  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minute = m.toString().padStart(2, "0");
  return `${hour12}:${minute} ${period}`;
}

export const matchLocation = (match: Match, lang: Lang) =>
  lang === "ar" ? match.locationAr : match.location;

/** WhatsApp registration deep link, carrying this booking's own details. */
export function registrationLink(match: Match, phone: string, lang: Lang) {
  const lines =
    lang === "ar"
      ? [
          "أرغب بالتسجيل في هذا الحجز:",
          "",
          dayName(match.date, "ar"),
          longDate(match.date, "ar"),
          prettyTime(match.time, "ar"),
          match.locationAr,
        ]
      : [
          "I would like to register for this booking:",
          "",
          dayName(match.date, "en"),
          longDate(match.date, "en"),
          prettyTime(match.time, "en"),
          match.location,
        ];
  return `https://wa.me/${phone}?text=${encodeURIComponent(lines.join("\n"))}`;
}

export const num = (v: number, lang: Lang) =>
  v.toLocaleString(localeOf(lang), { maximumFractionDigits: 0 });

export const pct = (v: number, lang: Lang) =>
  `${v.toLocaleString(localeOf(lang), { maximumFractionDigits: 1 })}%`;

export const rating = (v: number, lang: Lang) =>
  v.toLocaleString(localeOf(lang), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** Missing/blank data is displayed as 0 (no N/A anywhere on the site). */
export const numOrNA = (v: number | null, lang: Lang) => num(v ?? 0, lang);

export const pctOrNA = (v: number | null, lang: Lang) => pct(v ?? 0, lang);

export const ratingOrNA = (v: number | null, lang: Lang) => rating(v ?? 0, lang);

