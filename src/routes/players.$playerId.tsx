import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";

import { MonthFilter, PageShell, SectionTitle, StatCard } from "@/components/ui-kit";
import { getPlayerById } from "@/data/players";
import { isKeeper } from "@/data/types";
import { num, pct, rating as fmtRating } from "@/lib/format";
import { useI18n, type TKey } from "@/lib/i18n";
import { aggregateKeeper, aggregateOutfield, type Period } from "@/lib/stats";

export const Route = createFileRoute("/players/$playerId")({
  loader: ({ params }) => {
    const player = getPlayerById(params.playerId);
    if (!player) throw notFound();
    return { player };
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {
        meta: [
          { title: "Player not found — Al-Mustatil Al-Akhdar" },
          { name: "robots", content: "noindex" },
        ],
      };
    }
    const { player } = loaderData;
    const title = `${player.name} — Player Stats | Al-Mustatil Al-Akhdar`;
    const description = `Match statistics, points balance and monthly performance for ${player.name} at Al-Mustatil Al-Akhdar.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  component: PlayerProfile,
});

function PlayerProfile() {
  const { player } = Route.useLoaderData();
  const { t, lang } = useI18n();
  const [period, setPeriod] = useState<Period>("all");

  const keeper = isKeeper(player);
  const outStats = keeper ? null : aggregateOutfield(player, period);
  const gkStats = keeper ? aggregateKeeper(player, period) : null;

  return (
    <PageShell>
      <Link
        to="/players"
        className="mb-5 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-gold"
      >
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
        {t("profile.back")}
      </Link>

      <header className="glass-card topo-lines mb-6 grid gap-5 p-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-8">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.28em] text-gold uppercase">
            {t(`pos.${player.position}` as TKey)}
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight uppercase sm:text-5xl">
            {lang === "ar" ? player.nameAr : player.name}
          </h1>
        </div>
        <div className="rounded-2xl border border-gold/40 bg-gold/10 px-6 py-4 text-center">
          <p className="text-[11px] tracking-[0.18em] text-muted-foreground uppercase">
            {t("profile.points")}
          </p>
          <p className="stat-number mt-1 text-4xl text-gold sm:text-5xl">
            {num(player.points, lang)}
          </p>
        </div>
      </header>

      <SectionTitle>{t("profile.stats")}</SectionTitle>
      <MonthFilter value={period} onChange={setPeriod} />

      {!outStats && !gkStats ? (
        <p className="glass-card p-8 text-center text-muted-foreground">
          {t("profile.noData")}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
          <StatCard label={t("stat.games")} value={num((outStats ?? gkStats)!.gamesPlayed, lang)} />
          {outStats ? (
            <>
              <StatCard label={t("stat.goals")} value={num(outStats.goals, lang)} highlight />
              <StatCard label={t("stat.assists")} value={num(outStats.assists, lang)} highlight />
              <StatCard label={t("stat.shots")} value={num(outStats.shots, lang)} />
              <StatCard label={t("stat.sot")} value={num(outStats.shotsOnTarget, lang)} />
              <StatCard label={t("stat.passes")} value={num(outStats.passes, lang)} />
              <StatCard label={t("stat.passAcc")} value={pct(outStats.passAccuracy, lang)} />
              <StatCard label={t("stat.tackles")} value={num(outStats.tackles, lang)} />
              <StatCard label={t("stat.clearances")} value={num(outStats.clearances, lang)} />
              <StatCard label={t("stat.dribbles")} value={num(outStats.dribbles, lang)} />
              <StatCard label={t("stat.keyPasses")} value={num(outStats.keyPasses, lang)} />
              <StatCard label={t("stat.chances")} value={num(outStats.chancesCreated, lang)} />
              <StatCard
                label={t("stat.rating")}
                value={fmtRating(outStats.avgRating, lang)}
                highlight
              />
            </>
          ) : null}
          {gkStats ? (
            <>
              <StatCard label={t("stat.saves")} value={num(gkStats.saves, lang)} highlight />
              <StatCard label={t("stat.shotsFaced")} value={num(gkStats.shotsFaced, lang)} />
              <StatCard label={t("stat.conceded")} value={num(gkStats.goalsConceded, lang)} />
              <StatCard
                label={t("stat.savePct")}
                value={pct(gkStats.savePercentage, lang)}
                highlight
              />
              <StatCard
                label={t("stat.rating")}
                value={fmtRating(gkStats.avgRating, lang)}
                highlight
              />
            </>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
