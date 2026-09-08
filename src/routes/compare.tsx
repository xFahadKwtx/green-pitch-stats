import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { FeedErrorNotice } from "@/components/feed-error";
import { MonthFilter, PageHeader, PageShell, SectionTitle } from "@/components/ui-kit";
import type { Player } from "@/data/types";
import { numOrNA, pctOrNA, ratingOrNA } from "@/lib/format";
import { useI18n, type Lang, type TKey } from "@/lib/i18n";
import { playersQueryOptions } from "@/lib/players-query";
import { aggregateKeeper, aggregateOutfield, type Period } from "@/lib/stats";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/compare")({
  head: () => ({
    meta: [
      { title: "Player Comparison — Al-Mustatil Al-Akhdar" },
      {
        name: "description",
        content:
          "Compare two Al-Mustatil Al-Akhdar players side by side with their monthly match statistics.",
      },
      { property: "og:title", content: "Player Comparison — Al-Mustatil Al-Akhdar" },
      {
        property: "og:description",
        content: "See two players' statistics side by side for the same month.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(playersQueryOptions);
  },
  errorComponent: () => <FeedErrorNotice />,
  component: ComparePage,
});

/** One comparison row: two displayed values, no aggregate scoring of any kind. */
interface Row {
  key: TKey;
  /** Raw numbers used only to decide the per-stat visual hint. */
  a: number;
  b: number;
  /** Formatted display values. */
  aText: string;
  bText: string;
  /** Lower is better (Goals Conceded only). */
  lowerBetter?: boolean;
}

const displayName = (p: Player, lang: Lang) => (lang === "ar" ? p.nameAr : p.name);

function outfieldRows(player: Player, period: Period, lang: Lang) {
  const s = aggregateOutfield(player, period);
  const n = (key: TKey, v: number | null): Row => ({
    key,
    a: v ?? 0,
    b: 0,
    aText: numOrNA(v, lang),
    bText: "",
  });
  const rows: Row[] = [
    n("stat.games", s.gamesPlayed),
    n("stat.goals", s.goals),
    n("stat.assists", s.assists),
    n("stat.shots", s.shots),
    n("stat.sot", s.shotsOnTarget),
    n("stat.passes", s.passes),
    {
      key: "stat.passAcc",
      a: s.passAccuracy ?? 0,
      b: 0,
      aText: pctOrNA(s.passAccuracy, lang),
      bText: "",
    },
    n("stat.tackles", s.tackles),
    n("stat.clearances", s.clearances),
    n("stat.dribbles", s.dribbles),
    n("stat.keyPasses", s.keyPasses),
    n("stat.chances", s.chancesCreated),
    n("stat.mvp", s.mvpAwards),
    {
      key: "stat.highRating",
      a: s.highestRating ?? 0,
      b: 0,
      aText: ratingOrNA(s.highestRating, lang),
      bText: "",
    },
    {
      key: "stat.lowRating",
      a: s.lowestRating ?? 0,
      b: 0,
      aText: ratingOrNA(s.lowestRating, lang),
      bText: "",
    },
  ];
  return rows;
}

function keeperRows(player: Player, period: Period, lang: Lang) {
  const s = aggregateKeeper(player, period);
  if (!s) return [];
  const n = (key: TKey, v: number | null): Row => ({
    key,
    a: v ?? 0,
    b: 0,
    aText: numOrNA(v, lang),
    bText: "",
  });
  const rows: Row[] = [
    n("stat.games", s.gamesPlayed),
    n("stat.saves", s.saves),
    n("stat.shotsFaced", s.shotsFaced),
    { ...n("stat.conceded", s.goalsConceded), lowerBetter: true },
    {
      key: "stat.savePct",
      a: s.savePercentage ?? 0,
      b: 0,
      aText: pctOrNA(s.savePercentage, lang),
      bText: "",
    },
    n("stat.mvp", s.mvpAwards),
    {
      key: "stat.highRating",
      a: s.highestRating ?? 0,
      b: 0,
      aText: ratingOrNA(s.highestRating, lang),
      bText: "",
    },
    {
      key: "stat.lowRating",
      a: s.lowestRating ?? 0,
      b: 0,
      aText: ratingOrNA(s.lowestRating, lang),
      bText: "",
    },
  ];
  return rows;
}

/** Merge two single-player row lists, keeping only statistics both sides share. */
function mergeRows(left: Row[], right: Row[]): Row[] {
  const byKey = new Map(right.map((r) => [r.key, r]));
  const merged: Row[] = [];
  for (const l of left) {
    const r = byKey.get(l.key);
    if (!r) continue;
    merged.push({ ...l, b: r.a, bText: r.aText });
  }
  return merged;
}

function buildRows(p1: Player, p2: Player, period: Period, lang: Lang): Row[] {
  const bothKeepers = p1.playsKeeper && p2.playsKeeper;
  const bothOutfield = p1.playsOutfield && p2.playsOutfield;

  const sections: Row[] = [];
  if (bothOutfield) {
    sections.push(...mergeRows(outfieldRows(p1, period, lang), outfieldRows(p2, period, lang)));
  }
  if (bothKeepers) {
    const gk = mergeRows(keeperRows(p1, period, lang), keeperRows(p2, period, lang));
    for (const row of gk) {
      if (!sections.some((s) => s.key === row.key)) sections.push(row);
    }
  }
  if (sections.length === 0) {
    // Mixed roles: only logically shared statistics.
    const shared: TKey[] = ["stat.games", "stat.mvp", "stat.highRating", "stat.lowRating"];
    const rowsOf = (p: Player) =>
      p.playsOutfield ? outfieldRows(p, period, lang) : keeperRows(p, period, lang);
    const merged = mergeRows(rowsOf(p1), rowsOf(p2));
    return merged.filter((r) => shared.includes(r.key));
  }
  return sections;
}

function PlayerSelect({
  label,
  value,
  onChange,
  players,
  disabledId,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  players: Player[];
  disabledId?: string;
}) {
  const { t, lang } = useI18n();
  return (
    <label className="glass-card block p-4">
      <span className="mb-2 block text-[11px] font-semibold tracking-[0.2em] text-gold uppercase">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 w-full rounded-xl border border-border bg-background/60 px-3 text-base font-semibold outline-none focus:border-gold/60"
      >
        <option value="">{t("compare.select")}</option>
        {players.map((p) => (
          <option key={p.id} value={p.id} disabled={p.id === disabledId}>
            {displayName(p, lang)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ComparePage() {
  const { t, lang } = useI18n();
  const { data: players } = useSuspenseQuery(playersQueryOptions);
  const [period, setPeriod] = useState<Period>("all");
  const [id1, setId1] = useState("");
  const [id2, setId2] = useState("");

  const sorted = useMemo(
    () =>
      [...players].sort((a, b) => displayName(a, lang).localeCompare(displayName(b, lang))),
    [players, lang],
  );

  const p1 = sorted.find((p) => p.id === id1) ?? null;
  const p2 = sorted.find((p) => p.id === id2) ?? null;

  const rows = useMemo(
    () => (p1 && p2 ? buildRows(p1, p2, period, lang) : []),
    [p1, p2, period, lang],
  );

  return (
    <PageShell>
      <PageHeader
        eyebrow={t("brand")}
        title={t("compare.title")}
        subtitle={t("compare.sub")}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <PlayerSelect
          label={t("compare.player1")}
          value={id1}
          onChange={(v) => {
            setId1(v);
            if (v && v === id2) setId2("");
          }}
          players={sorted}
          disabledId={id2}
        />
        <PlayerSelect
          label={t("compare.player2")}
          value={id2}
          onChange={(v) => {
            setId2(v);
            if (v && v === id1) setId1("");
          }}
          players={sorted}
          disabledId={id1}
        />
      </div>

      <MonthFilter value={period} onChange={setPeriod} />

      {!p1 || !p2 ? (
        <p className="glass-card p-8 text-center text-muted-foreground">
          {t("compare.pickBoth")}
        </p>
      ) : rows.length === 0 ? (
        <p className="glass-card p-8 text-center text-muted-foreground">
          {t("compare.noShared")}
        </p>
      ) : (
        <section>
          <SectionTitle>{t("profile.stats")}</SectionTitle>
          <div className="glass-card overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border/70 px-3 py-4 sm:gap-4 sm:px-5">
              <p className="truncate text-center font-display text-base font-bold tracking-wide uppercase sm:text-lg">
                {displayName(p1, lang)}
              </p>
              <p className="text-center text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                {t("compare.statistic")}
              </p>
              <p className="truncate text-center font-display text-base font-bold tracking-wide uppercase sm:text-lg">
                {displayName(p2, lang)}
              </p>
            </div>

            <ul>
              {rows.map((row) => {
                const better = row.lowerBetter
                  ? row.a < row.b
                    ? "a"
                    : row.b < row.a
                      ? "b"
                      : null
                  : row.a > row.b
                    ? "a"
                    : row.b > row.a
                      ? "b"
                      : null;
                const cell = (side: "a" | "b") =>
                  cn(
                    "stat-number rounded-xl px-2 py-2 text-center text-xl sm:text-2xl",
                    better === side
                      ? "bg-gold/10 text-gold shadow-gold"
                      : "text-foreground",
                  );
                return (
                  <li
                    key={row.key}
                    className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border/40 px-3 py-2 last:border-0 sm:gap-4 sm:px-5"
                  >
                    <span className={cell("a")}>{row.aText}</span>
                    <span className="min-w-24 text-center text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase sm:min-w-40 sm:text-xs">
                      {t(row.key)}
                    </span>
                    <span className={cell("b")}>{row.bText}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}
    </PageShell>
  );
}
