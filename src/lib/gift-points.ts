/**
 * Gift Points helpers — pure, browser-safe. No transfer happens here: we only
 * build a WhatsApp message the visitor sends themselves for manual approval.
 */
import type { Player } from "@/data/types";

/** Airtable record ids (the mapper's fallback when "Player ID" is blank). */
const AIRTABLE_RECORD_ID = /^rec[A-Za-z0-9]{14}$/;

/** A real Airtable "Player ID" value — never a fallback record id. */
export function isRealPlayerId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  return trimmed.length > 0 && !AIRTABLE_RECORD_ID.test(trimmed);
}

/** Players eligible as gift recipients: must carry a real Player ID. */
export function giftablePlayers(players: Player[]): Player[] {
  return players.filter((p) => isRealPlayerId(p.id));
}

/** Parses a whole positive safe integer from user input, else null. */
export function parseGiftPoints(raw: string): number | null {
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export function giftMessage(
  lang: "en" | "ar",
  player: Pick<Player, "id" | "name" | "nameAr">,
  points: number,
): string {
  if (lang === "ar") {
    return [
      "السلام عليكم، أبي أهدي نقاط للاعب التالي 🎁",
      "",
      `اسم اللاعب: ${player.nameAr || player.name}`,
      `Player ID: ${player.id}`,
      `عدد النقاط: ${points}`,
    ].join("\n");
  }
  return [
    "Hello, I would like to gift points to the following player 🎁",
    "",
    `Player name: ${player.name || player.nameAr}`,
    `Player ID: ${player.id}`,
    `Points: ${points}`,
  ].join("\n");
}

/** Returns the wa.me link, or null when the player id or points are invalid. */
export function giftLink(
  whatsappNumber: string,
  lang: "en" | "ar",
  player: Pick<Player, "id" | "name" | "nameAr"> | null,
  rawPoints: string,
): string | null {
  if (!player || !isRealPlayerId(player.id)) return null;
  const points = parseGiftPoints(rawPoints);
  if (points === null) return null;
  return `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(giftMessage(lang, player, points))}`;
}
