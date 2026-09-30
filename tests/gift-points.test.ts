import { describe, expect, test } from "bun:test";

import {
  giftLink,
  giftMessage,
  giftablePlayers,
  isRealPlayerId,
  parseGiftPoints,
} from "../src/lib/gift-points";

const player = { id: "P-042", name: "Ali Saleh", nameAr: "علي صالح" };

describe("gift points", () => {
  test("rejects fallback Airtable record ids", () => {
    expect(isRealPlayerId("recAbCdEf12345678")).toBe(false);
    expect(isRealPlayerId("")).toBe(false);
    expect(isRealPlayerId("  ")).toBe(false);
    expect(isRealPlayerId("P-042")).toBe(true);
    const list = giftablePlayers([
      { ...player, id: "recAbCdEf12345678" },
      player,
    ] as never);
    expect(list.map((p) => p.id)).toEqual(["P-042"]);
  });

  test("points validation", () => {
    for (const bad of ["", " ", "0", "-5", "14", "31", "15.5", "20.0", "1e3", "abc", "Infinity", "NaN", "9007199254740993"])
      expect(parseGiftPoints(bad)).toBeNull();
    expect(parseGiftPoints("15")).toBe(15);
    expect(parseGiftPoints("30")).toBe(30);
    expect(parseGiftPoints(" 20 ")).toBe(20);
  });

  test("exact Arabic and English messages", () => {
    expect(giftMessage("ar", player, 50)).toBe(
      "السلام عليكم، أبي أهدي نقاط للاعب التالي 🎁\n\nاسم اللاعب: علي صالح\nPlayer ID: P-042\nعدد النقاط: 50",
    );
    expect(giftMessage("en", player, 50)).toBe(
      "Hello, I would like to gift points to the following player 🎁\n\nPlayer name: Ali Saleh\nPlayer ID: P-042\nPoints: 50",
    );
  });

  test("link only for valid input, encoded", () => {
    expect(giftLink("96551287700", "en", null, "5")).toBeNull();
    expect(giftLink("96551287700", "en", player, "0")).toBeNull();
    expect(giftLink("96551287700", "en", player, "14")).toBeNull();
    expect(giftLink("96551287700", "en", player, "31")).toBeNull();
    expect(giftLink("96551287700", "en", { ...player, id: "recAbCdEf12345678" }, "20")).toBeNull();
    const href = giftLink("96551287700", "ar", player, "15")!;
    expect(href.startsWith("https://wa.me/96551287700?text=")).toBe(true);
    expect(decodeURIComponent(href.split("text=")[1])).toBe(giftMessage("ar", player, 15));
  });
});
