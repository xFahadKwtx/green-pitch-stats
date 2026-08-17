import { createFileRoute, Link } from "@tanstack/react-router";
import { Crown } from "lucide-react";
import { useState } from "react";

import { MonthFilter, PageHeader, PageShell } from "@/components/ui-kit";
import { num, pct, rating as fmtRating } from "@/lib/format";
import { useI18n, type TKey } from "@/lib/i18n";
import { leaderboard, type Category } from "@/lib/leaderboard";
import type { Period, UnifiedStats } from "@/lib/stats";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Leaderboard — Al-Mustatil Al-Akhdar" },
      {
        name: "description",
        content:
          "Monthly rankings for Player of the Month, Top Scorer, Top Assists, Best Defender, Pass Accuracy and Best Goalkeeper.",
      },
      { property: "og:title", content: "Leaderboard — Al-Mustatil Al-Akhdar" },
      {
        property: "og:description",
        content: "See who leads every category this month at Al-Mustatil Al-Akhdar.",
      },
    ],
  }),
  component: LeaderboardPage,
});

interface Column {
  key: TKey;
  render: (s: UnifiedStats, lang: "en" | "ar") => string;
}

const boards: { category: Category; title: TKey; nameLabel: TKey; columns: Column[] }[] = [
  {
    category: "potm",
    title: "lb.potm",
    nameLabel: "lb.player",
    columns: [
      { key: "stat.games", render: (s, l) => num(s.gamesPlayed, l) },
      { key: "stat.mvp", render: (s, l) => num(s.mvpAwards, l) },
      { key: "stat.highRating", render: (s, l) => fmtRating(s.highestRating, l) },
    ],
  },
  {
    category: "scorer",
    title: "lb.scorer",
    nameLabel: "lb.player",
    columns: [
      { key: "stat.games", render: (s, l) => num(s.gamesPlayed, l) },
      { key: "stat.goals", render: (s, l) => num(s.goals, l) },
    ],
  },
  {
    category: "assists",
    title: "lb.assists",
    nameLabel: "lb.player",
    columns: [
      { key: "stat.games", render: (s, l) => num(s.gamesPlayed, l) },
      { key: "stat.assists", render: (s, l) => num(s.assists, l) },
    ],
  },
  {
    category: "defender",
    title: "lb.defender",
    nameLabel: "lb.player",
    columns: [
      { key: "stat.games", render: (s, l) => num(s.gamesPlayed, l) },
      { key: "stat.tackles", render: (s, l) => num(s.tackles, l) },
    ],
  },
  {
    category: "passing",
    title: "lb.passing",
    nameLabel: "lb.player",
    columns: [
      { key: "stat.games", render: (s, l) => num(s.gamesPlayed, l) },
      { key: "stat.passes", render: (s, l) => num(s.passes, l) },
      { key: "stat.passAcc", render: (s, l) => pct(s.passAccuracy, l) },
    ],
  },
  {
    category: "keeper",
    title: "lb.keeperTitle",
    nameLabel: "lb.keeper",
    columns: [
      { key: "stat.games", render: (s, l) => num(s.gamesPlayed, l) },
      { key: "stat.savePct", render: (s, l) => pct(s.savePercentage, l) },
    ],
  },
];

function Board({
  title,
  nameLabel,
  rows,
  columns,
}: {
  title: string;
  nameLabel: string;
  rows: UnifiedStats[];
  columns: Column[];
}) {
  const { t, lang } = useI18n();

  return (
    <section className="glass-card overflow-hidden">
      <header className="flex items-center gap-3 border-b border-border/70 px-5 py-4">
        <Crown className="h-5 w-5 shrink-0 text-gold" aria-hidden />
        <h2 className="min-w-0 truncate text-lg font-bold tracking-wide uppercase sm:text-xl">
          {title}
        </h2>
      </header>

      {rows.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">{t("lb.empty")}</p>
      ) : (
        <div className="no-scrollbar overflow-x-auto">
          <table className="w-full min-w-[26rem] border-collapse text-start">
            <thead>
              <tr className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                <th className="px-4 py-3 text-start font-semibold">{t("lb.rank")}</th>
                <th className="px-4 py-3 text-start font-semibold">{nameLabel}</th>
                {columns.map((c) => (
                  <th key={c.key} className="px-4 py-3 text-end font-semibold whitespace-nowrap">
                    {t(c.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => (
                <tr
                  key={s.player.id}
                  className={cn(
                    "border-t border-border/60 transition-colors hover:bg-glass",
                    i === 0 && "bg-gold/10",
                  )}
                >
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "stat-number grid h-8 w-8 place-items-center rounded-lg text-sm",
                        i === 0
                          ? "bg-gold text-primary-foreground"
                          : "border border-border bg-glass text-muted-foreground",
                      )}
                    >
                      {i + 1}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      to="/players/$playerId"
                      params={{ playerId: s.player.id }}
                      className={cn(
                        "font-display text-base font-semibold whitespace-nowrap hover:text-gold",
                        i === 0 && "text-gold",
                      )}
                    >
                      {lang === "ar" ? s.player.nameAr : s.player.name}
                    </Link>
                  </td>
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className="stat-number px-4 py-3 text-end text-base whitespace-nowrap"
                    >
                      {c.render(s, lang)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LeaderboardPage() {
  const { t } = useI18n();
  const [period, setPeriod] = useState<Period>("all");

  return (
    <PageShell>
      <PageHeader eyebrow={t("brand")} title={t("lb.title")} subtitle={t("lb.sub")} />
      <MonthFilter value={period} onChange={setPeriod} />
      <div className="grid gap-4 xl:grid-cols-2">
        {boards.map((b) => (
          <Board
            key={b.category}
            title={t(b.title)}
            nameLabel={t(b.nameLabel)}
            columns={b.columns}
            rows={leaderboard(b.category, period).slice(0, 10)}
          />
        ))}
      </div>
    </PageShell>
  );
}
