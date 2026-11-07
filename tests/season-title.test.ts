import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { announcement, seasonAnnouncement } from "@/data/site";
import {
  MONTH_NAMES_AR,
  MONTH_NAMES_EN,
  kuwaitMonthIndex,
  seasonTitleAr,
  seasonTitleEn,
} from "@/lib/season";

const source = (path: string) => readFileSync(path, "utf8");

// The home page banner names the season after the month running in Kuwait time.
test("november, december and january are named in both languages", () => {
  expect(seasonTitleEn(new Date("2026-11-07T15:54:00Z"))).toBe(
    "NOVEMBER SEASON IS LIVE",
  );
  expect(seasonTitleAr(new Date("2026-11-07T15:54:00Z"))).toBe(
    "موسم نوفمبر انطلق",
  );

  expect(seasonTitleEn(new Date("2026-12-25T00:00:00Z"))).toBe(
    "DECEMBER SEASON IS LIVE",
  );
  expect(seasonTitleAr(new Date("2026-12-25T00:00:00Z"))).toBe(
    "موسم ديسمبر انطلق",
  );

  expect(seasonTitleEn(new Date("2027-01-01T00:00:00Z"))).toBe(
    "JANUARY SEASON IS LIVE",
  );
  expect(seasonTitleAr(new Date("2027-01-01T00:00:00Z"))).toBe(
    "موسم يناير انطلق",
  );
});

test("the month is read in Kuwait time, not UTC", () => {
  // 2026-11-30 21:30 UTC is already 2026-12-01 00:30 in Kuwait (UTC+3).
  expect(kuwaitMonthIndex(new Date("2026-11-30T21:30:00Z"))).toBe(11);
  expect(seasonTitleAr(new Date("2026-11-30T21:30:00Z"))).toBe(
    "موسم ديسمبر انطلق",
  );
  expect(seasonTitleEn(new Date("2026-11-30T21:30:00Z"))).toBe(
    "DECEMBER SEASON IS LIVE",
  );

  // 2026-11-30 20:59 UTC is 23:59 in Kuwait: still November.
  expect(kuwaitMonthIndex(new Date("2026-11-30T20:59:00Z"))).toBe(10);
  expect(seasonTitleAr(new Date("2026-11-30T20:59:00Z"))).toBe(
    "موسم نوفمبر انطلق",
  );
});

test("all twelve months are named, in order, in both languages", () => {
  expect([...MONTH_NAMES_AR]).toEqual([
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
  ]);
  expect([...MONTH_NAMES_EN]).toEqual([
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
  ]);

  for (let month = 0; month < 12; month++) {
    // Midday UTC is midday in Kuwait, so the Kuwait month is the UTC month.
    const now = new Date(Date.UTC(2027, month, 15, 12, 0, 0));
    expect(kuwaitMonthIndex(now)).toBe(month);
    expect(seasonTitleEn(now)).toBe(
      `${(MONTH_NAMES_EN[month] ?? "").toUpperCase()} SEASON IS LIVE`,
    );
    expect(seasonTitleAr(now)).toBe(
      `موسم ${MONTH_NAMES_AR[month] ?? ""} انطلق`,
    );
  }
});

test("only the title is dynamic, the rest of the banner is unchanged", () => {
  const banner = seasonAnnouncement(new Date("2026-11-07T15:54:00Z"));
  expect(banner.title).toBe("NOVEMBER SEASON IS LIVE");
  expect(banner.titleAr).toBe("موسم نوفمبر انطلق");
  expect(banner.tag).toBe("Latest Announcement");
  expect(banner.tagAr).toBe("أحدث إعلان");
  expect(banner.body).toBe(
    "Football bookings every week, full match stats for every player, and monthly awards with real discounts. Register through WhatsApp and secure your spot on the pitch.",
  );
  expect(banner.bodyAr).toBe(
    "حجوزات كرة قدم كل أسبوع، إحصائيات كاملة لكل لاعب، وجوائز شهرية مع خصومات حقيقية. سجّل عبر واتساب واحفظ مكانك في الملعب.",
  );
  expect(banner.ctaLabel).toBe("View Upcoming Games");
  expect(banner.ctaLabelAr).toBe("شاهد المباريات القادمة");
  expect(banner.ctaHref).toBe("/upcoming-games");
  expect(announcement.ctaHref).toBe("/upcoming-games");
});

test("no month is hard-coded in the banner data or the home route", () => {
  const site = source("src/data/site.ts");
  expect(site.includes("SEPTEMBER")).toBe(false);
  expect(site.includes("سبتمبر")).toBe(false);

  const route = source("src/routes/index.tsx");
  expect(route.includes("seasonAnnouncement")).toBe(true);
  expect(route.includes("kuwaitMonthIndex")).toBe(true);
  expect(route.includes("SEPTEMBER SEASON IS LIVE")).toBe(false);
  expect(route.includes("موسم سبتمبر انطلق")).toBe(false);
});
