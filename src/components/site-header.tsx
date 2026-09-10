import { Link } from "@tanstack/react-router";
import { Menu, X, Globe } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

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

export function SiteHeader() {
  const { t, lang, toggle } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const brandRef = useRef<HTMLAnchorElement>(null);

  const closeMenu = useCallback((restoreTrigger = false) => {
    const desktop = window.matchMedia("(min-width: 80rem)").matches;
    const active = document.activeElement;
    // Move focus before making the panel inert, but respect focus already
    // moved by navigation. On desktop use the brand, not the hidden trigger.
    if (
      restoreTrigger ||
      panelRef.current?.contains(active) ||
      (desktop && active === triggerRef.current)
    ) {
      (desktop ? brandRef.current : triggerRef.current)?.focus({ preventScroll: true });
    }
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    // Match Tailwind's xl breakpoint (1280px at the default font size).
    const desktop = window.matchMedia("(min-width: 80rem)");
    const onChange = () => {
      if (desktop.matches) closeMenu();
    };
    onChange();
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, [closeMenu]);

  return (
    <header
      className="sticky top-0 z-50 border-b border-border/70 bg-background/80 backdrop-blur-xl"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          closeMenu(true);
        }
      }}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4 sm:h-20 sm:px-6">
        <Link
          to="/"
          ref={brandRef}
          onClick={() => closeMenu()}
          className="flex min-w-0 items-center gap-2"
        >
          <img
            src={logoAsset.url}
            alt={t("brand")}
            className="h-9 w-9 shrink-0 object-contain sm:h-11 sm:w-11"
          />
          <span className="min-w-0">
            <span className="block truncate font-display text-sm leading-tight font-bold tracking-wide uppercase sm:text-lg">
              {t("brand")}
            </span>
            <span className="hidden truncate text-[10px] tracking-[0.18em] text-muted-foreground uppercase sm:block">
              {t("brandTag")}
            </span>
          </span>
        </Link>

        <nav className="ms-auto hidden flex-1 items-center justify-end gap-0.5 xl:flex">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              activeOptions={{ exact: l.to === "/" }}
              className="whitespace-nowrap rounded-full px-2 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-glass hover:text-foreground data-[status=active]:bg-glass data-[status=active]:text-gold"
            >
              {t(l.key)}
            </Link>
          ))}
        </nav>

        <div className="ms-auto flex shrink-0 items-center gap-2 xl:ms-2">
          <button
            type="button"
            onClick={toggle}
            aria-label={t("language.switch")}
            className="flex h-10 items-center gap-1.5 rounded-full border border-border px-2.5 text-[13px] font-semibold text-foreground transition-colors hover:border-gold/60 hover:text-gold"
          >
            <Globe className="h-4 w-4" aria-hidden />
            <span>{lang === "en" ? "AR" : "EN"}</span>
          </button>
          <button
            type="button"
            ref={triggerRef}
            onClick={() => (open ? closeMenu() : setOpen(true))}
            aria-label={open ? t("close") : t("menu")}
            aria-expanded={open}
            aria-controls={panelId}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-foreground xl:hidden"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      <div
        ref={panelRef}
        id={panelId}
        inert={!open}
        className={cn(
          "overflow-y-auto border-t border-border/70 bg-background/95 transition-[max-height] duration-300 xl:hidden",
          open
            ? "max-h-[calc(100dvh-4rem)] sm:max-h-[calc(100dvh-5rem)]"
            : "max-h-0",
        )}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <nav className="mx-auto grid max-w-6xl gap-1 px-4 py-3 pb-10">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              activeOptions={{ exact: l.to === "/" }}
              onClick={() => closeMenu()}
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
