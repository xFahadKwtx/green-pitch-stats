import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DoublePointsBadge } from "../src/components/double-points-badge";

const source = (path: string) => readFileSync(path, "utf8");

// The ⚡ 2X marker is a Players Stats indicator only: it must not appear on the
// leaderboard or comparison pages, and must stay on the players list and profile.
test("badge is removed from leaderboard and compare sources", () => {
  for (const path of ["src/routes/leaderboard.tsx", "src/routes/compare.tsx"]) {
    const code = source(path);
    expect(code.includes("DoublePointsBadge")).toBe(false);
    expect(code.includes("doublePoints")).toBe(false);
    expect(code.includes("2X")).toBe(false);
    expect(code.includes("badge.doublePoints")).toBe(false);
  }
});

test("badge stays on the players list and player profile", () => {
  for (const path of ["src/routes/players.index.tsx", "src/routes/players.$playerId.tsx"]) {
    const code = source(path);
    expect(code.includes('import { DoublePointsBadge } from "@/components/double-points-badge"')).toBe(true);
    expect(code.includes("doublePoints")).toBe(true);
    expect(code.includes('t("badge.doublePoints")')).toBe(true);
  }
});

test("badge component still renders the enlarged marker when active", () => {
  const on = renderToStaticMarkup(createElement(DoublePointsBadge, { active: true, label: "نقاط مضاعفة" }));
  expect(on).toContain("2X");
  expect(on).toContain("text-sm");
  expect(on).toContain("sm:text-base");
  expect(renderToStaticMarkup(createElement(DoublePointsBadge, { active: false, label: "x" }))).toBe("");
});
