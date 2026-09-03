import { Link } from "@tanstack/react-router";
import { Menu, X, Globe, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import logoAsset from "@/assets/logo.png.asset.json";
import { useI18n, type TKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const links: { to: string; key: TKey }[] = [
  { to: "/", key: "nav.home" },
  { to: "/upcoming-games", key: "nav.games" },
  { to: "/players", key: "nav.players" },
  { to: "/compare", key: "nav.compare" },
  { to: "/leaderboard", key: "nav.leaderboard" },
  { to: "/records", key: "nav.records" },
  { to: "/store", key: "nav.store" },
  { to: "/rewards", key: "nav.rewards" },
  { to: "/contact", key: "nav.contact" },
];

// Primary items always visible on desktop; lower-priority items collapse
// into a "More" dropdown so labels never wrap onto a second line.
const primaryLinks = links.slice(0, 6);
const moreLinks = links.slice(6);

export function SiteHeader() {
  const { t, lang, toggle } = useI18n();
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

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

        <nav className="ms-auto hidden items-center gap-0.5 flex-nowrap lg:flex">
          {primaryLinks.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              activeOptions={{ exact: l.to === "/" }}
              className="whitespace-nowrap rounded-full px-2.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-glass hover:text-foreground data-[status=active]:bg-glass data-[status=active]:text-gold"
            >
              {t(l.key)}
            </Link>
          ))}
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              className="flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-glass hover:text-foreground"
            >
              {t("nav.more")}
              <ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", moreOpen && "rotate-180")}
                aria-hidden
              />
            </button>
            {moreOpen && (
              <div
                role="menu"
                className="absolute end-0 mt-2 min-w-[12rem] overflow-hidden rounded-2xl border border-border/70 bg-background/95 p-1 shadow-xl backdrop-blur-xl"
              >
                {moreLinks.map((l) => (
                  <Link
                    key={l.to}
                    to={l.to}
                    activeOptions={{ exact: l.to === "/" }}
                    onClick={() => setMoreOpen(false)}
                    className="block whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-glass hover:text-foreground data-[status=active]:bg-glass data-[status=active]:text-gold"
                  >
                    {t(l.key)}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </nav>

        <div className="ms-auto flex items-center gap-2 lg:ms-2">
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
