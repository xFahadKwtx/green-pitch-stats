import { createFileRoute } from "@tanstack/react-router";

import { absoluteUrl } from "@/lib/site";

const STATIC_PATHS = [
  "/",
  "/upcoming-games",
  "/players",
  "/compare",
  "/leaderboard",
  "/records",
  "/store",
  "/rewards",
  "/contact",
];

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildSitemapXml(playerIds: string[]): string {
  const paths = [...STATIC_PATHS, ...playerIds.map((id) => `/players/${encodeURIComponent(id)}`)];
  const urls = paths
    .map((p) => `  <url><loc>${xmlEscape(absoluteUrl(p))}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        let playerIds: string[] = [];
        try {
          // Read-only: reuses the same cached, visibility-filtered public players feed.
          const { getPlayers } = await import("@/lib/players.functions");
          const players = await getPlayers();
          playerIds = players.map((p) => p.id);
        } catch {
          // Fail safe: still serve the static routes rather than an error.
          playerIds = [];
        }
        return new Response(buildSitemapXml(playerIds), {
          headers: { "content-type": "application/xml; charset=utf-8" },
        });
      },
    },
  },
});
