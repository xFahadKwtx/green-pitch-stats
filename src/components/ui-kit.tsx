import type { ReactNode } from "react";

import { MONTHS } from "@/data/types";
import { useI18n, type TKey } from "@/lib/i18n";
import type { Period } from "@/lib/stats";
import { cn } from "@/lib/utils";

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 pt-8 pb-4 sm:px-6 sm:pt-12">
      {children}
    </main>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-8 sm:mb-10">
      {eyebrow ? (
        <p className="mb-2 text-[11px] font-semibold tracking-[0.3em] text-gold uppercase">
          {eyebrow}
        </p>
      ) : null}
      <h1 className="text-3xl font-bold tracking-tight uppercase sm:text-5xl">{title}</h1>
      {subtitle ? (
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-4 flex items-center gap-3 text-xl font-bold tracking-wide uppercase sm:text-2xl">
      <span className="h-5 w-1.5 rounded-full bg-gold" aria-hidden />
      {children}
    </h2>
  );
}

export function MonthFilter({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  const { t } = useI18n();
  const options: { value: Period; label: string }[] = [
    ...MONTHS.map((m) => ({ value: m as Period, label: t(`month.${m}` as TKey) })),
    { value: "all", label: t("filter.all") },
  ];

  return (
    <div className="no-scrollbar -mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="flex w-max min-w-full gap-2 rounded-full border border-border bg-glass p-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            className={cn(
              "min-h-11 flex-1 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors",
              value === o.value
                ? "bg-gold text-primary-foreground shadow-gold"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "glass-card p-4 transition-transform duration-300 hover:-translate-y-0.5 sm:p-5",
        highlight && "border-gold/40",
      )}
    >
      <p className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          "stat-number mt-2 text-3xl sm:text-4xl",
          highlight ? "text-gold" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-3 py-1 text-xs font-semibold tracking-wide text-gold uppercase">
      {children}
    </span>
  );
}
