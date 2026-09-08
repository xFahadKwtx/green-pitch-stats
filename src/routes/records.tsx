import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Crown, Trophy, UserMinus } from "lucide-react";

import { FeedErrorNotice } from "@/components/feed-error";
import { PageHeader, PageShell } from "@/components/ui-kit";
import type { RecordEntry } from "@/data/types";
import { useI18n } from "@/lib/i18n";
import { recordsQueryOptions } from "@/lib/records-query";

export const Route = createFileRoute("/records")({
  head: () => ({
    meta: [
      { title: "Records — Al-Mustatil Al-Akhdar" },
      {
        name: "description",
        content:
          "The breakable football records board. See every current mark and the player holding it — then go break it.",
      },
      { property: "og:title", content: "Records — Al-Mustatil Al-Akhdar" },
      {
        property: "og:description",
        content:
          "The breakable records board for Al-Mustatil Al-Akhdar. See the marks and who holds them.",
      },
    ],
  }),
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(recordsQueryOptions);
  },
  errorComponent: () => <FeedErrorNotice />,
  component: RecordsPage,
});

function RecordCard({ record }: { record: RecordEntry }) {
  const { t, lang } = useI18n();
  const name = lang === "ar" ? record.nameAr || record.nameEn : record.nameEn || record.nameAr;
  const holderName =
    lang === "ar"
      ? record.holderNameAr || record.holderNameEn
      : record.holderNameEn || record.holderNameAr;
  const hasHolder = holderName !== null;

  return (
    <article className="glass-card topo-lines group relative flex flex-col gap-5 overflow-hidden p-6 transition-transform duration-300 hover:-translate-y-1 hover:border-gold/40 sm:p-7">
      {/* glow accent */}
      <div
        className="pointer-events-none absolute -top-16 -right-10 h-40 w-40 rounded-full bg-gold/15 blur-3xl transition-opacity duration-300 group-hover:opacity-90"
        aria-hidden
      />

      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.24em] text-gold uppercase">
            {t("records.eyebrow")}
          </p>
          <h2 className="mt-1.5 text-xl font-bold leading-tight tracking-tight sm:text-2xl">
            {name}
          </h2>
        </div>
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-gold/40 bg-gold/10 text-gold">
          <Trophy className="h-6 w-6" aria-hidden />
        </span>
      </header>

      <div className="relative">
        <p className="stat-number text-5xl font-bold text-gold sm:text-6xl">
          {record.value}
        </p>
      </div>

      <footer className="mt-auto flex items-center gap-3 rounded-2xl border border-border bg-glass px-4 py-3.5">
        {hasHolder ? (
          <>
            <Crown className="h-5 w-5 shrink-0 text-gold" aria-hidden />
            <span className="min-w-0">
              <span className="block text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                {t("records.holder")}
              </span>
              <span className="block truncate font-display text-lg font-semibold">
                {holderName}
              </span>
            </span>
          </>
        ) : (
          <>
            <UserMinus className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-sm font-medium text-muted-foreground">
              {t("records.unclaimed")}
            </span>
          </>
        )}
      </footer>
    </article>
  );
}

function RecordsPage() {
  const { t } = useI18n();
  const { data: records } = useSuspenseQuery(recordsQueryOptions);

  return (
    <PageShell>
      <PageHeader
        eyebrow={t("records.eyebrow")}
        title={t("records.title")}
        subtitle={t("records.sub")}
      />
      {records.length === 0 ? (
        <p className="glass-card p-8 text-center text-muted-foreground">
          {t("records.empty")}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {records.map((r) => (
            <RecordCard key={r.id} record={r} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
