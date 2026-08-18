import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, BarChart3, CalendarDays, Gift, Trophy } from "lucide-react";

import logoAsset from "@/assets/logo.png.asset.json";
import { Badge, PageShell } from "@/components/ui-kit";
import { playersQueryOptions } from "@/lib/players-query";
import { announcement } from "@/data/site";
import { useI18n, type TKey } from "@/lib/i18n";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Al-Mustatil Al-Akhdar — Football Stats & Weekly Games" },
      {
        name: "description",
        content:
          "Weekly football bookings, full player statistics, monthly leaderboards and rewards for the Al-Mustatil Al-Akhdar community in Kuwait.",
      },
      { property: "og:title", content: "Al-Mustatil Al-Akhdar — Football Stats Platform" },
      {
        property: "og:description",
        content:
          "Register for weekly games on WhatsApp, track your match statistics and climb the monthly leaderboards.",
      },
    ],
  }),
  component: Home,
});

const quickLinks: { to: string; key: TKey; icon: typeof Trophy }[] = [
  { to: "/upcoming-games", key: "nav.games", icon: CalendarDays },
  { to: "/players", key: "nav.players", icon: BarChart3 },
  { to: "/leaderboard", key: "nav.leaderboard", icon: Trophy },
  { to: "/rewards", key: "nav.rewards", icon: Gift },
];

function Home() {
  const { t, lang } = useI18n();

  return (
    <PageShell>
      <section className="topo-lines glass-card overflow-hidden">
        <div className="pitch-grid px-5 py-10 text-center sm:px-10 sm:py-16">
          <img
            src={logoAsset.url}
            alt={t("brand")}
            className="mx-auto h-28 w-28 object-contain drop-shadow-2xl sm:h-40 sm:w-40"
          />
          <h1 className="mt-6 text-4xl leading-[0.95] font-bold tracking-tight uppercase sm:text-6xl">
            {t("home.hero.title")}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-lg">
            {t("home.hero.sub")}
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Link
              to="/upcoming-games"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-gold px-6 text-sm font-bold tracking-wide text-primary-foreground uppercase shadow-gold transition-transform hover:-translate-y-0.5"
            >
              {t("home.cta.games")}
              <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
            </Link>
            <Link
              to="/players"
              className="inline-flex min-h-12 items-center justify-center rounded-full border border-border bg-glass px-6 text-sm font-bold tracking-wide uppercase transition-colors hover:border-gold/50 hover:text-gold"
            >
              {t("home.cta.stats")}
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-6">
        <article className="glass-card overflow-hidden border-gold/30">
          <div className="grid gap-5 p-6 sm:grid-cols-[1fr_auto] sm:items-center sm:p-8">
            <div className="min-w-0">
              <Badge>{lang === "ar" ? announcement.tagAr : announcement.tag}</Badge>
              <h2 className="mt-3 text-2xl font-bold tracking-tight uppercase sm:text-4xl">
                {lang === "ar" ? announcement.titleAr : announcement.title}
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
                {lang === "ar" ? announcement.bodyAr : announcement.body}
              </p>
            </div>
            {announcement.ctaHref === "/upcoming-games" ? (
              <Link
                to="/upcoming-games"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-gold px-6 text-sm font-bold tracking-wide text-primary-foreground uppercase shadow-gold transition-transform hover:-translate-y-0.5"
              >
                {lang === "ar" ? announcement.ctaLabelAr : announcement.ctaLabel}
              </Link>
            ) : null}
          </div>
        </article>
      </section>

      <section className="mt-6 grid grid-cols-3 gap-3 sm:gap-4">
        {[
          { value: players.length, label: t("home.stats.players") },
          { value: 64, label: t("home.stats.matches") },
          { value: 12, label: t("home.stats.metrics") },
        ].map((s) => (
          <div key={s.label} className="glass-card p-4 text-center sm:p-6">
            <p className="stat-number text-3xl text-gold sm:text-5xl">{s.value}</p>
            <p className="mt-2 text-[11px] tracking-[0.12em] text-muted-foreground uppercase sm:text-xs">
              {s.label}
            </p>
          </div>
        ))}
      </section>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        {quickLinks.map(({ to, key, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="glass-card flex min-h-24 flex-col justify-between p-4 transition-transform duration-300 hover:-translate-y-0.5 hover:border-gold/40 sm:p-5"
          >
            <Icon className="h-6 w-6 text-gold" aria-hidden />
            <span className="mt-4 font-display text-base font-semibold tracking-wide uppercase sm:text-lg">
              {t(key)}
            </span>
          </Link>
        ))}
      </section>
    </PageShell>
  );
}
