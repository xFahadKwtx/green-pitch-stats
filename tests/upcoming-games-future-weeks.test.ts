import { describe, expect, test } from "bun:test";
import type { Match } from "../src/data/types";
import { eligibleBookings, isBookingEligible, MAX_TRANSITION_DELAY_MS, nextBookingTransition } from "../src/lib/upcoming-games";

const game = (id: string, date: string, time: string): Match =>
  ({ id, date, time, location: { ar: id, en: id } } as unknown as Match);
const NOW = Date.parse("2026-10-03T21:58:00+03:00");
const omHani = game("om-hani", "2026-10-04", "20:00");
const fintas = game("fintas", "2026-10-09", "21:00");

describe("all future weeks are eligible", () => {
  test("Oct 4 and Oct 9 both visible on Oct 3 21:58 Kuwait, in order", () => {
    expect(eligibleBookings([fintas, omHani], NOW).map(g => g.id)).toEqual(["om-hani", "fintas"]);
  });
  test("each hides exactly at its Kuwait kickoff", () => {
    const k1 = Date.parse("2026-10-04T20:00:00+03:00");
    expect(isBookingEligible(omHani, k1 - 1)).toBe(true);
    expect(isBookingEligible(omHani, k1)).toBe(false);
    expect(eligibleBookings([omHani, fintas], k1).map(g => g.id)).toEqual(["fintas"]);
    const k2 = Date.parse("2026-10-09T21:00:00+03:00");
    expect(isBookingEligible(fintas, k2 - 1)).toBe(true);
    expect(eligibleBookings([omHani, fintas], k2)).toEqual([]);
  });
  test("malformed and past games stay excluded", () => {
    const bad = [game("a", "2026-02-30", "20:00"), game("b", "2026-10-05", "25:00"), game("c", "x", "20:00"), game("d", "2026-10-01", "20:00")];
    expect(eligibleBookings([...bad, fintas], NOW).map(g => g.id)).toEqual(["fintas"]);
  });
  test("timer: earliest future start, capped for empty or far-future lists", () => {
    expect(nextBookingTransition([fintas, omHani], NOW)).toBe(Date.parse("2026-10-04T20:00:00+03:00"));
    expect(nextBookingTransition([], NOW)).toBe(NOW + MAX_TRANSITION_DELAY_MS);
    expect(nextBookingTransition([game("far", "2099-01-01", "20:00")], NOW)).toBe(NOW + MAX_TRANSITION_DELAY_MS);
    expect(MAX_TRANSITION_DELAY_MS).toBeLessThan(2 ** 31 - 1);
    expect(nextBookingTransition([fintas], NOW)).toBeGreaterThan(NOW);
  });
});
