import { QueryErrorResetBoundary, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Clock, Loader2, MapPin, MessageCircle, Navigation, Users } from "lucide-react";
import { Suspense, useEffect, useState, type MouseEvent } from "react";

import { FeedErrorNotice } from "@/components/feed-error";
import { RetryBoundary } from "@/components/retry-boundary";
import { PageHeader, PageShell } from "@/components/ui-kit";
import { contactInfo } from "@/data/site";
import type { Match } from "@/data/types";
import {
  dayName,
  longDate,
  matchFormatLabel,
  matchLocation,
  prettyTime,
  registrationLink,
} from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { upcomingGamesQueryOptions } from "@/lib/upcoming-games-query";
import { eligibleBookings, isBookingEligible, nextBookingTransition } from "@/lib/upcoming-games";
import { absoluteUrl } from "@/lib/site";

export const Route = createFileRoute("/upcoming-games")({
  head: () => ({
    meta: [
      { title: "Upcoming Games — Al-Mustatil Al-Akhdar" },
      {
        name: "description",
        content:
          "Upcoming football bookings with day, date, time and location. Register instantly on WhatsApp.",
      },
      { property: "og:title", content: "Upcoming Games — Al-Mustatil Al-Akhdar" },
      {
        property: "og:description",
        content: "See upcoming bookings and register on WhatsApp in one tap.",
      },
      { property: "og:url", content: absoluteUrl("/upcoming-games") },
    ],
    links: [{ rel: "canonical", href: absoluteUrl("/upcoming-games") }],
  }),
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(upcomingGamesQueryOptions);
  },
  errorComponent: () => <FeedErrorNotice />,
  pendingComponent: () => (
    <PageShell>
      <GamesLoading />
    </PageShell>
  ),
  component: UpcomingGames,
});

function GameCard({ match, onExpired }: { match: Match; onExpired: () => void }) {
  const { t, lang } = useI18n();
  const guardRegistration = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isBookingEligible(match, Date.now())) {
      event.preventDefault();
      onExpired();
    }
  };
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
        {match.matchFormat ? (
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-glass px-4 py-3">
            <Users className="h-5 w-5 shrink-0 text-gold" aria-hidden />
            <div className="min-w-0">
              <dt className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                {t("games.matchFormat")}
              </dt>
              <dd className="stat-number truncate text-lg">
                {matchFormatLabel(match.matchFormat, lang)}
              </dd>
            </div>
          </div>
        ) : null}
        {match.locationUrl ? (
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-glass px-4 py-3">
            <Navigation className="h-5 w-5 shrink-0 text-gold" aria-hidden />
            <div className="min-w-0">
              <dt className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                {t("games.pitchLocation")}
              </dt>
              <dd className="truncate text-lg">
                <a
                  href={match.locationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="stat-number font-semibold text-gold underline-offset-4 hover:underline"
                >
                  {t("games.openMap")}
                </a>
              </dd>
            </div>
          </div>
        ) : null}
      </dl>

      <a
        href={registrationLink(match, contactInfo.whatsappNumber, lang)}
        onClick={guardRegistration}
        onAuxClick={guardRegistration}
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

function GamesLoading() {
  const { t } = useI18n();
  return (
    <div role="status" aria-live="polite" className="glass-card flex items-center justify-center gap-3 p-8 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin text-gold" aria-hidden />
      <span>{t("games.loading")}</span>
    </div>
  );
}

function GamesError({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="glass-card flex flex-col items-center gap-4 p-8 text-center text-muted-foreground">
      <p>{t("error.generic")}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-11 items-center justify-center rounded-full bg-gold px-6 text-sm font-bold text-primary-foreground"
      >
        {t("games.retry")}
      </button>
    </div>
  );
}

function UpcomingGames() {
  const { t } = useI18n();
  return (
    <PageShell>
      <PageHeader eyebrow={t("brand")} title={t("games.title")} subtitle={t("games.sub")} />
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <RetryBoundary onReset={reset} fallback={(retry) => <GamesError onRetry={retry} />}>
            <Suspense fallback={<GamesLoading />}>
              <GamesList />
            </Suspense>
          </RetryBoundary>
        )}
      </QueryErrorResetBoundary>
    </PageShell>
  );
}

function GamesList() {
  const { t } = useI18n();
  const { data: upcomingMatches } = useSuspenseQuery(upcomingGamesQueryOptions);
  const [, setNow] = useState(Date.now);

  useEffect(() => {
    let timer: number | undefined;
    const recheck = () => {
      const now = Date.now();
      setNow(now);
      window.clearTimeout(timer);
      timer = window.setTimeout(recheck, nextBookingTransition(upcomingMatches, now) - now);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    recheck();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [upcomingMatches]);

  const visibleMatches = eligibleBookings(upcomingMatches, Date.now());

  return visibleMatches.length === 0 ? (
    <p className="glass-card p-8 text-center text-muted-foreground">{t("games.empty")}</p>
  ) : (
    <div className="grid gap-4 lg:grid-cols-2">
      {visibleMatches.map((m) => (
        <GameCard key={m.id} match={m} onExpired={() => setNow(Date.now())} />
      ))}
    </div>
  );
}
