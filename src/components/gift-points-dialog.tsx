import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Loader2, Search } from "lucide-react";
import { useId, useMemo, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { contactInfo } from "@/data/site";
import { giftablePlayers, giftLink, isRealPlayerId, parseGiftPoints } from "@/lib/gift-points";
import { useI18n } from "@/lib/i18n";
import { playersQueryOptions } from "@/lib/players-query";

/** Trigger + dialog. Players load only once the dialog is opened. */
export function GiftPointsAction() {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSession((s) => s + 1);
          setOpen(true);
        }}
        className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full bg-gold px-3.5 text-[13px] font-bold text-primary-foreground shadow-gold ${
          lang === "ar" ? "flex-row-reverse" : "flex-row"
        }`}
        style={{ direction: "ltr" }}
      >
        {/* Physical order is fixed via direction:ltr: AR → emoji left, EN → emoji right. */}
        <span dir={lang === "ar" ? "rtl" : "ltr"}>{t("store.gift")}</span>
        <span aria-hidden>🎁</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? <GiftForm key={session} /> : null}
      </Dialog>
    </>
  );
}

function GiftForm() {
  const { t, lang } = useI18n();
  const ids = useId();
  const query = useQuery({ ...playersQueryOptions, enabled: true });
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [points, setPoints] = useState("");
  const [touched, setTouched] = useState(false);

  const players = useMemo(() => giftablePlayers(query.data ?? []), [query.data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return players;
    return players.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.nameAr.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q),
    );
  }, [players, search]);

  // Clear a selection that is no longer a valid, available recipient.
  const selected =
    selectedId && isRealPlayerId(selectedId)
      ? (players.find((p) => p.id === selectedId) ?? null)
      : null;

  const pointsValue = parseGiftPoints(points);
  const href = giftLink(contactInfo.whatsappNumber, lang, selected, points);
  const nameOf = (p: { name: string; nameAr: string }) =>
    lang === "ar" ? p.nameAr || p.name : p.name || p.nameAr;

  const fieldCls =
    "w-full rounded-xl border border-border bg-background/60 px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-gold/60";

  return (
    <DialogContent
      dir={lang === "ar" ? "rtl" : "ltr"}
      className="glass-card max-h-[90vh] w-[calc(100%-1.5rem)] overflow-y-auto rounded-2xl border-gold/30 p-5 sm:p-6"
    >
      <DialogHeader className="text-start sm:text-start">
        <DialogTitle className="pe-8 text-xl font-bold">{t("gift.title")}</DialogTitle>
        <DialogDescription className="text-[13px] leading-relaxed">
          {t("gift.explain")}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <label htmlFor={`${ids}-search`} className="text-sm font-semibold">
          {t("gift.recipient")}
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            id={`${ids}-search`}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("gift.search")}
            className={`${fieldCls} ps-9`}
            autoComplete="off"
          />
        </div>

        {query.isPending ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("gift.loading")}
          </p>
        ) : query.isError ? (
          <div className="flex items-center justify-between gap-3 py-3 text-sm" role="alert">
            <span className="text-muted-foreground">{t("gift.error")}</span>
            <button
              type="button"
              onClick={() => query.refetch()}
              className="min-h-10 rounded-full border border-gold/40 px-3.5 text-[13px] font-bold text-gold"
            >
              {t("gift.retry")}
            </button>
          </div>
        ) : players.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">{t("gift.empty")}</p>
        ) : filtered.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">{t("gift.noResults")}</p>
        ) : (
          <div
            role="radiogroup"
            aria-label={t("gift.recipient")}
            className="max-h-52 space-y-1 overflow-y-auto rounded-xl border border-border bg-background/40 p-1.5"
          >
            {filtered.map((p) => {
              const checked = selected?.id === p.id;
              return (
                <label
                  key={p.id}
                  className={`flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gold/60 ${
                    checked ? "bg-gold/15 text-gold" : "hover:bg-glass"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <input
                      type="radio"
                      name={`${ids}-player`}
                      value={p.id}
                      checked={checked}
                      onChange={() => setSelectedId(p.id)}
                      className="accent-[var(--gold)] sr-only"
                    />
                    <span className="truncate font-semibold">{nameOf(p)}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground" dir="ltr">
                    {p.id}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {selected ? (
          <p className="text-xs text-muted-foreground">
            {t("gift.selected")}: <span className="font-semibold text-foreground">{nameOf(selected)}</span>{" "}
            <span dir="ltr">({selected.id})</span>
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <label htmlFor={`${ids}-points`} className="text-sm font-semibold">
          {t("gift.points")}
        </label>
        <input
          id={`${ids}-points`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={touched && pointsValue === null}
          aria-describedby={`${ids}-points-hint`}
          className={fieldCls}
          dir="ltr"
        />
        <p
          id={`${ids}-points-hint`}
          className={`text-xs ${touched && pointsValue === null ? "text-destructive" : "text-muted-foreground"}`}
        >
          {t("gift.pointsHint")}
        </p>
      </div>

      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full bg-gold px-4 text-sm font-bold text-primary-foreground shadow-gold"
        >
          {t("gift.send")}
          <ArrowUpRight className="h-4 w-4" aria-hidden />
        </a>
      ) : (
        <button
          type="button"
          disabled
          className="inline-flex min-h-11 cursor-not-allowed items-center justify-center gap-1.5 rounded-full bg-gold px-4 text-sm font-bold text-primary-foreground opacity-50"
        >
          {t("gift.send")}
          <ArrowUpRight className="h-4 w-4" aria-hidden />
        </button>
      )}
    </DialogContent>
  );
}
