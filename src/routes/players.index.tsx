import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { PageHeader, PageShell } from "@/components/ui-kit";
import { type Position } from "@/data/types";
import { useI18n, type TKey } from "@/lib/i18n";
import { playersQueryOptions } from "@/lib/players-query";

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
    ],
  }),
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(playersQueryOptions);
  },
  errorComponent: ({ error }) => (
    <div role="alert" className="p-8 text-center text-muted-foreground">
      {error.message}
    </div>
  ),
  component: PlayersPage,
});

function PlayersPage() {
  const { t, lang } = useI18n();
  const [query, setQuery] = useState("");
  const { data: players } = useSuspenseQuery(playersQueryOptions);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return players;
    return players.filter(
      (p) => p.name.toLowerCase().includes(q) || p.nameAr.includes(query.trim()),
    );
  }, [players, query]);

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

      <p className="mb-4 text-xs tracking-[0.16em] text-muted-foreground uppercase">
        {results.length} {t("players.count")}
      </p>

      {results.length === 0 ? (
        <p className="glass-card p-8 text-center text-muted-foreground">
          {t("players.empty")}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
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
                    {p.positions.length > 0
                      ? p.positions.join(" · ")
                      : t(`pos.${p.positionGroup}` as TKey)}
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
