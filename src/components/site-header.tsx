import { Link } from "@tanstack/react-router";
import { Menu, X, Globe } from "lucide-react";
import { useEffect, useState } from "react";

import logoAsset from "@/assets/logo.png.asset.json";
import { useI18n, type TKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const links: { to: string; key: TKey }[] = [
  { to: "/", key: "nav.home" },
  { to: "/upcoming-games", key: "nav.games" },
  { to: "/players", key: "nav.players" },
  { to: "/leaderboard", key: "nav.leaderboard" },
  { to: "/store", key: "nav.store" },
  { to: "/rewards", key: "nav.rewards" },
  { to: "/contact", key: "nav.contact" },
];

export function SiteHeader() {
  const { t, lang, toggle } = useI18n();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-50 border-b border-border/70 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:h-20 sm:px-6">
        <Link
          to="/"
          onClick={() => setOpen(false)}
          className="flex min-w-0 items-center gap-3"
        >
          <img
            src={logoAsset.url}
            alt={t("brand")}
            className="h-10 w-10 shrink-0 object-contain sm:h-12 sm:w-12"
          />
          <span className="min-w-0">
            <span className="block truncate font-display text-base leading-tight font-bold tracking-wide uppercase sm:text-xl">
              {t("brand")}
            </span>
            <span className="hidden text-[11px] tracking-[0.2em] text-muted-foreground uppercase sm:block">
              {t("brandTag")}
            </span>
          </span>
        </Link>

        <nav className="ms-auto hidden items-center gap-1 lg:flex">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              activeOptions={{ exact: l.to === "/" }}
              className="rounded-full px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-glass hover:text-foreground data-[status=active]:bg-glass data-[status=active]:text-gold"
            >
              {t(l.key)}
            </Link>
          ))}
        </nav>

        <div className="ms-auto flex items-center gap-2 lg:ms-3">
          <button
            type="button"
            onClick={toggle}
            aria-label="Switch language"
            className="flex h-11 items-center gap-2 rounded-full border border-border px-3 text-sm font-semibold text-foreground transition-colors hover:border-gold/60 hover:text-gold"
          >
            <Globe className="h-4 w-4" aria-hidden />
            <span>{lang === "en" ? "AR" : "EN"}</span>
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? t("close") : t("menu")}
            aria-expanded={open}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-border text-foreground lg:hidden"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      <div
        className={cn(
          "overflow-hidden border-t border-border/70 bg-background/95 transition-[max-height] duration-300 lg:hidden",
          open ? "max-h-[26rem]" : "max-h-0",
        )}
      >
        <nav className="mx-auto grid max-w-6xl gap-1 px-4 py-3">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              activeOptions={{ exact: l.to === "/" }}
              onClick={() => setOpen(false)}
              className="rounded-xl px-4 py-3.5 text-base font-medium text-muted-foreground transition-colors hover:bg-glass hover:text-foreground data-[status=active]:bg-glass data-[status=active]:text-gold"
            >
              {t(l.key)}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
