import { createFileRoute } from "@tanstack/react-router";
import { ShoppingBag } from "lucide-react";

import { PageHeader, PageShell } from "@/components/ui-kit";
import { contactInfo, storeProducts } from "@/data/site";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/store")({
  head: () => ({
    meta: [
      { title: "Store — Al-Mustatil Al-Akhdar" },
      {
        name: "description",
        content:
          "Official Al-Mustatil Al-Akhdar store. Kit and gear drops are announced here.",
      },
      { property: "og:title", content: "Store — Al-Mustatil Al-Akhdar" },
      {
        property: "og:description",
        content: "Official Al-Mustatil Al-Akhdar kit and gear, coming soon.",
      },
    ],
  }),
  component: StorePage,
});

function StorePage() {
  const { t, lang } = useI18n();

  return (
    <PageShell>
      <PageHeader eyebrow={t("brand")} title={t("store.title")} subtitle={t("store.sub")} />

      {storeProducts.length === 0 ? (
        <div className="glass-card topo-lines flex flex-col items-center gap-4 px-6 py-14 text-center">
          <span className="grid h-16 w-16 place-items-center rounded-2xl border border-gold/30 bg-gold/10">
            <ShoppingBag className="h-8 w-8 text-gold" aria-hidden />
          </span>
          <h2 className="text-2xl font-bold tracking-tight uppercase sm:text-3xl">
            {t("store.empty.title")}
          </h2>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
            {t("store.empty.body")}
          </p>
          <a
            href={`https://wa.me/${contactInfo.whatsappNumber}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-12 items-center justify-center rounded-full bg-gold px-6 text-sm font-bold tracking-wide text-primary-foreground uppercase shadow-gold transition-transform hover:-translate-y-0.5"
          >
            {t("store.notify")}
          </a>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {storeProducts.map((p) => (
            <article key={p.id} className="glass-card overflow-hidden">
              <div className="aspect-square bg-glass">
                {p.imageUrl ? (
                  <img
                    src={p.imageUrl}
                    alt={lang === "ar" ? p.nameAr : p.name}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : null}
              </div>
              <div className="p-4">
                <h2 className="truncate font-display text-base font-semibold">
                  {lang === "ar" ? p.nameAr : p.name}
                </h2>
                <p className="stat-number mt-1 text-xl text-gold">
                  {p.price} {p.currency}
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
    </PageShell>
  );
}
