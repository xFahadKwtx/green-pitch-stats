import { createFileRoute } from "@tanstack/react-router";
import { Clock, MapPin, MessageCircle } from "lucide-react";

import { PageHeader, PageShell } from "@/components/ui-kit";
import { upcomingMatches } from "@/data/matches";
import { contactInfo } from "@/data/site";
import type { Match } from "@/data/types";
import {
  dayName,
  longDate,
  matchLocation,
  prettyTime,
  registrationLink,
} from "@/lib/format";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/upcoming-games")({
  head: () => ({
    meta: [
      { title: "Upcoming Games — Al-Mustatil Al-Akhdar" },
      {
        name: "description",
        content:
          "This week's football bookings with day, date, time and location. Register instantly on WhatsApp.",
      },
      { property: "og:title", content: "Upcoming Games — Al-Mustatil Al-Akhdar" },
      {
        property: "og:description",
        content: "See this week's bookings and register on WhatsApp in one tap.",
      },
    ],
  }),
  component: UpcomingGames,
});

function GameCard({ match }: { match: Match }) {
  const { t, lang } = useI18n();
  return (
    <article className="glass-card topo-lines flex flex-col gap-5 p-5 transition-transform duration-300 hover:-translate-y-0.5 hover:border-gold/40 sm:p-6">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.24em] text-gold uppercase">
            {dayName(match.date, lang)}
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight uppercase sm:text-3xl">
            {longDate(match.date, lang)}
          </h2>
        </div>
        {match.spotsLeft !== undefined ? (
          <span className="shrink-0 rounded-full border border-border bg-glass px-3 py-1.5 text-xs font-semibold text-muted-foreground">
            {match.spotsLeft} {t("games.spots")}
          </span>
        ) : null}
      </header>

      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-glass px-4 py-3">
          <Clock className="h-5 w-5 shrink-0 text-gold" aria-hidden />
          <div className="min-w-0">
            <dt className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              {t("games.time")}
            </dt>
            <dd className="stat-number truncate text-lg">{prettyTime(match.time, lang)}</dd>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-glass px-4 py-3">
          <MapPin className="h-5 w-5 shrink-0 text-gold" aria-hidden />
          <div className="min-w-0">
            <dt className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              {t("games.location")}
            </dt>
            <dd className="truncate font-display text-lg font-semibold">
              {matchLocation(match, lang)}
            </dd>
          </div>
        </div>
      </dl>

      <a
        href={registrationLink(match, contactInfo.whatsappNumber, lang)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-13 w-full items-center justify-center gap-2 rounded-full bg-gold px-6 text-sm font-bold tracking-wide text-primary-foreground uppercase shadow-gold transition-transform hover:-translate-y-0.5"
      >
        <MessageCircle className="h-5 w-5" aria-hidden />
        {t("games.register")}
      </a>
    </article>
  );
}

function UpcomingGames() {
  const { t } = useI18n();
  return (
    <PageShell>
      <PageHeader
        eyebrow={t("brand")}
        title={t("games.title")}
        subtitle={t("games.sub")}
      />
      {upcomingMatches.length === 0 ? (
        <p className="glass-card p-8 text-center text-muted-foreground">
          {t("games.empty")}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {upcomingMatches.map((m) => (
            <GameCard key={m.id} match={m} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
