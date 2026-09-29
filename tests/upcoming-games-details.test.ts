import { describe, expect, test } from "bun:test";

import type { Match } from "../src/data/types";
import { matchFormatLabel } from "../src/lib/format";
import {
  eligibleBookings,
  normalizeBooking,
  normalizeLocationUrl,
  normalizeMatchFormat,
} from "../src/lib/upcoming-games";

const baseMatch: Match = {
  id: "rec1",
  date: "2026-10-04",
  time: "22:00",
  location: "Pitch A",
  locationAr: "ملعب أ",
};

describe("normalizeLocationUrl", () => {
  test("accepts absolute https URLs", () => {
    expect(normalizeLocationUrl("https://maps.google.com/?q=29.3,47.9")).toBe(
      "https://maps.google.com/?q=29.3,47.9",
    );
  });

  test("accepts absolute http URLs", () => {
    expect(normalizeLocationUrl("http://maps.example.com/x")).toBe(
      "http://maps.example.com/x",
    );
  });

  test("rejects unsafe schemes", () => {
    expect(normalizeLocationUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeLocationUrl("data:text/html,<script>")).toBeUndefined();
    expect(normalizeLocationUrl("file:///etc/passwd")).toBeUndefined();
  });

  test("rejects relative and malformed values", () => {
    expect(normalizeLocationUrl("/maps/pitch")).toBeUndefined();
    expect(normalizeLocationUrl("maps.google.com")).toBeUndefined();
    expect(normalizeLocationUrl("not a url")).toBeUndefined();
  });

  test("rejects empty and non-string values", () => {
    expect(normalizeLocationUrl("")).toBeUndefined();
    expect(normalizeLocationUrl("   ")).toBeUndefined();
    expect(normalizeLocationUrl(undefined)).toBeUndefined();
    expect(normalizeLocationUrl(null)).toBeUndefined();
    expect(normalizeLocationUrl(42)).toBeUndefined();
  });
});

describe("normalizeMatchFormat", () => {
  test("accepts the four known choices", () => {
    expect(normalizeMatchFormat("6v6")).toBe("6v6");
    expect(normalizeMatchFormat("7v7")).toBe("7v7");
    expect(normalizeMatchFormat("8v8")).toBe("8v8");
    expect(normalizeMatchFormat("9v9")).toBe("9v9");
  });

  test("never invents a default for missing or unknown values", () => {
    expect(normalizeMatchFormat("")).toBeUndefined();
    expect(normalizeMatchFormat(undefined)).toBeUndefined();
    expect(normalizeMatchFormat(null)).toBeUndefined();
    expect(normalizeMatchFormat("5v5")).toBeUndefined();
    expect(normalizeMatchFormat("11v11")).toBeUndefined();
    expect(normalizeMatchFormat("seven")).toBeUndefined();
  });
});

describe("normalizeBooking with the new details", () => {
  test("keeps valid map link and format", () => {
    const normalized = normalizeBooking({
      ...baseMatch,
      locationUrl: "https://maps.google.com/?q=1,2",
      matchFormat: "7v7",
    });
    expect(normalized?.locationUrl).toBe("https://maps.google.com/?q=1,2");
    expect(normalized?.matchFormat).toBe("7v7");
  });

  test("drops invalid or blank details instead of failing the booking", () => {
    const normalized = normalizeBooking({
      ...baseMatch,
      locationUrl: "javascript:alert(1)",
      matchFormat: "5v5",
    });
    expect(normalized).not.toBeNull();
    expect(normalized?.locationUrl).toBeUndefined();
    expect(normalized?.matchFormat).toBeUndefined();
  });

  test("old cached matches without the new fields stay valid and hidden", () => {
    const normalized = normalizeBooking({ ...baseMatch });
    expect(normalized).not.toBeNull();
    expect(normalized?.locationUrl).toBeUndefined();
    expect(normalized?.matchFormat).toBeUndefined();
  });

  test("eligibility filtering still applies with the new fields present", () => {
    const now = Date.UTC(2026, 9, 1, 12, 0, 0); // Thursday; booking Sat Oct 3 is in-week
    const eligible = eligibleBookings(
      [
        {
          ...baseMatch,
          date: "2026-10-03",
          locationUrl: "https://maps.google.com/?q=1,2",
          matchFormat: "8v8",
        },
      ],
      now,
    );
    expect(eligible).toHaveLength(1);
    expect(eligible[0]?.matchFormat).toBe("8v8");
  });
});

describe("matchFormatLabel", () => {
  test("renders English and Arabic forms", () => {
    expect(matchFormatLabel("7v7", "en")).toBe("7v7");
    expect(matchFormatLabel("7v7", "ar")).toBe("7 ضد 7");
    expect(matchFormatLabel("9v9", "ar")).toBe("9 ضد 9");
  });
});
