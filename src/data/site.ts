import type { Announcement, PositionChallenge, StoreProduct } from "./types";
import { seasonTitleAr, seasonTitleEn } from "@/lib/season";

export const contactInfo = {
  phone: "+965 51287700",
  /** digits only, used for wa.me links */
  whatsappNumber: "96551287700",
  whatsappGroup:
    "https://chat.whatsapp.com/L7UqblII3EX9uVQBbQaEYa?s=cl&p=i&ilr=4",
  instagram: "https://instagram.com/Almustatil.Alakhdar",
  instagramHandle: "@Almustatil.Alakhdar",
  tiktok: "https://www.tiktok.com/@Almustatil.Alakhdar",
  tiktokHandle: "@Almustatil.Alakhdar",
};

/**
 * Edit this object to change the home page banner.
 *
 * The month is deliberately not written here: the title follows the current
 * month in Kuwait time, so the card rolls over on its own every month. See
 * seasonAnnouncement() and src/lib/season.ts.
 */
export const announcement = {
  id: "ann-2026-08",
  tag: "Latest Announcement",
  tagAr: "أحدث إعلان",
  body: "Football bookings every week, full match stats for every player, and monthly awards with real discounts. Register through WhatsApp and secure your spot on the pitch.",
  bodyAr:
    "حجوزات كرة قدم كل أسبوع، إحصائيات كاملة لكل لاعب، وجوائز شهرية مع خصومات حقيقية. سجّل عبر واتساب واحفظ مكانك في الملعب.",
  ctaLabel: "View Upcoming Games",
  ctaLabelAr: "شاهد المباريات القادمة",
  ctaHref: "/upcoming-games",
} satisfies Omit<Announcement, "title" | "titleAr">;

/** The banner with its title set to the current month in Kuwait time. */
export function seasonAnnouncement(now: Date): Announcement {
  return {
    ...announcement,
    title: seasonTitleEn(now),
    titleAr: seasonTitleAr(now),
  };
}

/** Add products here (or from the database later) and the store grid fills in. */
export const storeProducts: StoreProduct[] = [];

/** Add each position's challenge here later. */
export const positionChallenges: PositionChallenge[] = [];
