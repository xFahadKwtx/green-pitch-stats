import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { FeedErrorNotice } from "@/components/feed-error";
import { PageHeader, PageShell } from "@/components/ui-kit";
import { type Player, type Position } from "@/data/types";
import { useI18n, type TKey } from "@/lib/i18n";
import { playersQueryOptions } from "@/lib/players-query";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/players/")({
  head: () => ({
    meta: [
      { title: "Players Stats — Al-Mustatil Al-Akhdar" },
      {
        name: "description",
        content:
          "Searchable directory of every Al-Mustatil Al-Akhdar player with position and full monthly match statistics.",
      },
      { property: "og:title", content: "Players Stats — Al-Mustatil Al-Akhdar" },
      {
        property: "og:description",
        content: "Browse the squad and open any player for detailed match statistics.",
      },
      { property: "og:url", content: "/players" },
    ],
    links: [{ rel: "canonical", href: "/players" }],
  }),
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(playersQueryOptions);
  },
  errorComponent: () => <FeedErrorNotice />,
  component: PlayersPage,
});

const POSITION_OPTIONS: { value: Position | "all"; labelKey: TKey }[] = [
  { value: "all", labelKey: "filter.all" },
  { value: "GK", labelKey: "pos.GK" },
  { value: "DEF", labelKey: "pos.DEF" },
  { value: "MID", labelKey: "pos.MID" },
  { value: "FWD", labelKey: "pos.FWD" },
];

/** Sub-position tokens that map to each main category. Case-insensitive. */
const CATEGORY_TOKENS: Record<Exclude<Position, "all">, string[]> = {
  GK: ["GK"],
  DEF: ["CB", "RB", "LB", "RWB", "LWB", "DEF"],
  MID: ["CM", "CDM", "CAM", "RM", "LM", "MID"],
  FWD: ["ST", "CF", "RW", "LW", "FWD"],
};

/** Splits a raw position string on any separator and normalizes each token. */
function normalizePositions(raw: string[]): string[] {
  const tokens: string[] = [];
  for (const entry of raw) {
    for (const part of entry.split(/[•\-/,\s]+/)) {
      const tag = part.trim().toUpperCase();
      if (tag) tokens.push(tag);
    }
  }
  return tokens;
}

/** True when the player belongs to the given main category by ANY of their tokens. */
function playerMatchesCategory(p: Player, cat: Position): boolean {
  const tokens = normalizePositions(p.positions);
  return CATEGORY_TOKENS[cat].some((token) => tokens.includes(token));
}

/** Unique recognized categories in position order, using the filter's rules. */
function playerCategories(p: Player): Position[] {
  const categories: Position[] = [];
  for (const token of normalizePositions(p.positions)) {
    const category = (Object.keys(CATEGORY_TOKENS) as Position[]).find((cat) =>
      CATEGORY_TOKENS[cat].includes(token),
    );
    if (category && !categories.includes(category)) categories.push(category);
  }
  return categories;
}

function PlayersPage() {
  const { t, lang } = useI18n();
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<Position | "all">("all");
  const { data: players } = useSuspenseQuery(playersQueryOptions);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byText = q
      ? players.filter(
          (p) => p.name.toLowerCase().includes(q) || p.nameAr.includes(query.trim()),
        )
      : players;
    return position === "all"
      ? byText
      : byText.filter((p) => playerMatchesCategory(p, position));
  }, [players, query, position]);

  return (
    <PageShell>
      <PageHeader
        eyebrow={t("brand")}
        title={t("players.title")}
        subtitle={t("players.sub")}
      />

      <div className="glass-card mb-5 flex items-center gap-3 px-4 py-1">
        <Search className="h-5 w-5 shrink-0 text-gold" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("players.search")}
          aria-label={t("players.search")}
          className="min-h-12 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs tracking-[0.16em] text-muted-foreground uppercase">
          {results.length} {t("players.count")}
        </p>
        <div
          role="group"
          aria-label={t("players.search")}
          className="no-scrollbar flex max-w-full min-w-0 gap-1.5 overflow-x-auto rounded-full border border-border bg-glass p-1"
        >
          {POSITION_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setPosition(o.value)}
              aria-pressed={position === o.value}
              className={cn(
                "min-h-9 rounded-full px-3 text-xs font-semibold tracking-wide whitespace-nowrap transition-colors",
                position === o.value
                  ? "bg-gold text-primary-foreground shadow-gold"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(o.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {results.length === 0 ? (
        <p className="glass-card p-8 text-center text-muted-foreground">
          {t("players.empty")}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {results.map((p) => (
            <li key={p.id}>
              <Link
                to="/players/$playerId"
                params={{ playerId: p.id }}
                className="glass-card flex items-center gap-4 p-4 transition-transform duration-300 hover:-translate-y-0.5 hover:border-gold/40"
              >
                <span className="stat-number grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-gold/30 bg-gold/10 text-sm text-gold">
                  {p.positionGroup}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-lg font-semibold tracking-wide">
                    {lang === "ar" ? p.nameAr : p.name}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {playerCategories(p)
                      .map((category) =>
                        // This compact label uses the approved short Arabic name.
                        lang === "ar" && category === "GK"
                          ? "حارس"
                          : t(`pos.${category}` as TKey).toUpperCase(),
                      )
                      .join(" • ")}
                  </span>
                </span>
                <ChevronRight
                  className="h-5 w-5 shrink-0 text-muted-foreground rtl:rotate-180"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
