import { Link } from "@tanstack/react-router";

import logoAsset from "@/assets/logo.png.asset.json";
import { contactInfo } from "@/data/site";
import { useI18n } from "@/lib/i18n";

export function SiteFooter() {
  const { t } = useI18n();
  return (
    <footer className="mt-20 border-t border-border/70 bg-pitch-deep/40">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 sm:px-6 md:grid-cols-[1fr_auto] md:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <img src={logoAsset.url} alt="" className="h-10 w-10 shrink-0 object-contain" />
          <div className="min-w-0">
            <p className="font-display text-lg font-bold tracking-wide uppercase">
              {t("brand")}
            </p>
            <p className="text-sm text-muted-foreground">{contactInfo.phone}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <Link to="/rewards" className="hover:text-gold">
            {t("nav.rewards")}
          </Link>
          <Link to="/leaderboard" className="hover:text-gold">
            {t("nav.leaderboard")}
          </Link>
          <Link to="/contact" className="hover:text-gold">
            {t("nav.contact")}
          </Link>
        </div>
      </div>
      <div className="mx-auto max-w-6xl border-t border-border/60 px-4 py-5 text-xs text-muted-foreground sm:px-6">
        © {new Date().getFullYear()} {t("brand")} — {t("footer.rights")}
      </div>
    </footer>
  );
}
