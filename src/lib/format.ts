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

export function prettyTime(time: string, lang: Lang) {
  const [h, m] = time.split(":").map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.toLocaleTimeString(localeOf(lang), {
    hour: "numeric",
    minute: "2-digit",
  });
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

