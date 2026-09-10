import { describe, expect, it } from "bun:test";

import { SITE_URL, absoluteUrl } from "../src/lib/site";
import { buildSitemapXml } from "../src/routes/sitemap[.]xml";

describe("site url helper", () => {
  it("uses the canonical production origin", () => {
    expect(SITE_URL).toBe("https://almustatil.lovable.app");
    expect(absoluteUrl("/")).toBe("https://almustatil.lovable.app/");
    expect(absoluteUrl("/store")).toBe("https://almustatil.lovable.app/store");
    expect(absoluteUrl("players")).toBe("https://almustatil.lovable.app/players");
  });
});

describe("sitemap", () => {
  const xml = buildSitemapXml(["p001", "p077"]);
  it("is valid xml with the canonical origin", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<urlset");
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
    expect(xml).not.toContain("<loc>http://");
  });
  it("lists static routes and given players only", () => {
    for (const p of ["/", "/players", "/store", "/records", "/rewards", "/contact", "/compare", "/leaderboard", "/upcoming-games"]) {
      expect(xml).toContain(`<loc>${absoluteUrl(p)}</loc>`);
    }
    expect(xml).toContain("<loc>https://almustatil.lovable.app/players/p001</loc>");
    expect(xml).toContain("<loc>https://almustatil.lovable.app/players/p077</loc>");
    expect((xml.match(/\/players\//g) ?? []).length).toBe(2);
  });
});
