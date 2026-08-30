import type { Announcement, PositionChallenge, StoreProduct } from "./types";

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

/** Edit this object to change the home page banner. */
export const announcement: Announcement = {
  id: "ann-2026-08",
  tag: "Latest Announcement",
  tagAr: "أحدث إعلان",
  title: "SEPTEMBER SEASON IS LIVE",
  titleAr: "موسم أغسطس انطلق",
  body: "Football bookings every week, full match stats for every player, and monthly awards with real discounts. Register through WhatsApp and secure your spot on the pitch.",
  bodyAr:
    "أربع حجوزات كل أسبوع، إحصائيات كاملة لكل لاعب، وجوائز شهرية مع خصومات حقيقية. سجّل عبر واتساب واحفظ مكانك في الملعب.",
  ctaLabel: "View Upcoming Games",
  ctaLabelAr: "شاهد المباريات القادمة",
  ctaHref: "/upcoming-games",
};

/** Add products here (or from the database later) and the store grid fills in. */
export const storeProducts: StoreProduct[] = [];

/** Add each position's challenge here later. */
export const positionChallenges: PositionChallenge[] = [];
