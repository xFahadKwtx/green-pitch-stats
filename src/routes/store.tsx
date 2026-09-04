import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight, ShoppingBag, Sparkles } from "lucide-react";

import { PageHeader, PageShell } from "@/components/ui-kit";
import type { StoreCategorySection, StoreItem } from "@/data/types";
import { contactInfo } from "@/data/site";
import { useI18n } from "@/lib/i18n";
import { storeQueryOptions } from "@/lib/store-query";

export const Route = createFileRoute("/store")({
  head: () => ({
    meta: [
      { title: "Store — Al-Mustatil Al-Akhdar" },
      {
        name: "description",
        content:
          "Explore the Al-Mustatil Al-Akhdar store and order football rewards with points through WhatsApp.",
      },
      { property: "og:title", content: "Store — Al-Mustatil Al-Akhdar" },
      {
        property: "og:description",
        content:
          "Browse football rewards from Al-Mustatil Al-Akhdar and request products through WhatsApp.",
      },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(storeQueryOptions),
  errorComponent: ({ error }) => (
    <div role="alert" className="p-8 text-center text-muted-foreground">
      {error.message}
    </div>
  ),
  notFoundComponent: () => (
    <div className="p-8 text-center text-muted-foreground">Store not found.</div>
  ),
  component: StorePage,
});

function pointsLabel(points: number | null, lang: "en" | "ar") {
  const value = (points ?? 0).toLocaleString(lang === "ar" ? "ar-KW" : "en-GB");
  return lang === "ar" ? `${value} نقاط` : `${value} Points`;
}

function orderLink(product: StoreItem, lang: "en" | "ar") {
  const productName = lang === "ar" ? product.nameAr || product.nameEn : product.nameEn || product.nameAr;
  const points = product.requiredPoints ?? 0;
  const message =
    lang === "ar"
      ? ["السلام عليكم، أرغب بهذا المنتج:", "", productName, `النقاط المطلوبة: ${points} نقطة`]
      : ["Hello, I would like to order this product:", "", productName, `Required Points: ${points} Points`];

  return `https://wa.me/${contactInfo.whatsappNumber}?text=${encodeURIComponent(message.join("\n"))}`;
}

/** Whether a product has a valid discounted redemption price. */
function hasDiscount(product: StoreItem) {
  return product.discountPoints != null && product.discountPoints > 0;
}

/**
 * Price display for a product card.
 * - No discount: shows the Required Points value normally.
 * - Discount: shows the original Required Points with a red strikethrough and
 *   the Discount Points value next to it, more visually prominent.
 */
function PriceTag({
  product,
  variant,
}: {
  product: StoreItem;
  variant: "badge" | "full";
}) {
  const { lang } = useI18n();
  const discounted = hasDiscount(product);

  if (variant === "badge") {
    // Compact badge: when discounted, show the discounted price as the headline.
    return (
      <>
        <Sparkles className="h-3 w-3" aria-hidden />
        {discounted
          ? pointsLabel(product.discountPoints, lang)
          : pointsLabel(product.requiredPoints, lang)}
      </>
    );
  }

  if (discounted) {
    return (
      <span className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-muted-foreground line-through decoration-red-500 decoration-2 sm:text-base">
          {pointsLabel(product.requiredPoints, lang)}
        </span>
        <span className="stat-number text-xl text-gold sm:text-2xl">
          {pointsLabel(product.discountPoints, lang)}
        </span>
      </span>
    );
  }

  return (
    <span className="stat-number text-xl text-gold sm:text-2xl">
      {pointsLabel(product.requiredPoints, lang)}
    </span>
  );
}

function ProductCard({ product }: { product: StoreItem }) {
  const { t, lang } = useI18n();
  const name = lang === "ar" ? product.nameAr || product.nameEn : product.nameEn || product.nameAr;
  const description = lang === "ar" ? product.descriptionAr : product.descriptionEn;

  return (
    <article className="glass-card group flex h-full flex-col overflow-hidden transition-transform duration-300 hover:-translate-y-1 hover:border-gold/40">
      <div className="relative aspect-square overflow-hidden border-b border-border bg-glass">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={name}
            loading="lazy"
            className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="grid h-full place-items-center text-gold/70" aria-hidden>
            <ShoppingBag className="h-10 w-10" strokeWidth={1.25} />
          </div>
        )}
        <span className="absolute top-2 end-2 inline-flex items-center gap-1 rounded-full border border-gold/40 bg-background/80 px-2.5 py-1 text-[11px] font-bold text-gold backdrop-blur-sm">
          <PriceTag product={product} variant="badge" />
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4 sm:p-5">
        <div>
          <h3 className="text-lg font-bold leading-tight sm:text-xl">{name}</h3>
          {description ? (
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>

        <div className="mt-auto flex items-end justify-between gap-2 border-t border-border pt-3">
          <PriceTag product={product} variant="full" />
          <a
            href={orderLink(product, lang)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-gold px-3.5 text-[13px] font-bold text-primary-foreground shadow-gold transition-transform hover:-translate-y-0.5"
          >
            {t("store.order")}
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </a>
        </div>
      </div>
    </article>
  );
}

function CategorySection({ category }: { category: StoreCategorySection }) {
  const { lang } = useI18n();
  const name = lang === "ar" ? category.nameAr || category.nameEn : category.nameEn || category.nameAr;

  return (
    <section aria-labelledby={`store-category-${category.id}`} className="space-y-4 sm:space-y-5">
      <div className="flex items-center gap-3 border-b border-border pb-3">
        <span className="h-6 w-1.5 rounded-full bg-gold" aria-hidden />
        <h2 id={`store-category-${category.id}`} className="text-2xl font-bold tracking-tight sm:text-3xl">
          {name}
        </h2>
        <span className="rounded-full border border-border bg-glass px-3 py-1 text-xs font-semibold text-muted-foreground">
          {category.products.length}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {category.products.map((product) => (
          <ProductCard key={`${category.id}-${product.id}`} product={product} />
        ))}
      </div>
    </section>
  );
}

function StorePage() {
  const { t } = useI18n();
  const { data: categories } = useSuspenseQuery(storeQueryOptions);

  return (
    <PageShell>
      <PageHeader eyebrow={t("brand")} title={t("store.title")} subtitle={t("store.sub")} />
      {categories.length === 0 ? (
        <div className="glass-card topo-lines flex flex-col items-center gap-4 px-6 py-14 text-center">
          <span className="grid h-16 w-16 place-items-center rounded-2xl border border-gold/30 bg-gold/10">
            <ShoppingBag className="h-8 w-8 text-gold" aria-hidden />
          </span>
          <h2 className="text-2xl font-bold tracking-tight uppercase sm:text-3xl">{t("store.empty.title")}</h2>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{t("store.empty.body")}</p>
        </div>
      ) : (
        <div className="space-y-10 sm:space-y-14">
          {categories.map((category) => (
            <CategorySection key={category.id} category={category} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
