import { lazy, Suspense, useState } from "react";

import { Dialog } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";

const GiftForm = lazy(() => import("./gift-points-dialog"));

/** Gift Points trigger. The form and players feed load only once opened. */
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
        {/* direction:ltr fixes physical order: AR → 🎁 left of text, EN → 🎁 right. */}
        <span dir={lang === "ar" ? "rtl" : "ltr"}>{t("store.gift")}</span>
        <span aria-hidden>🎁</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <Suspense fallback={null}>
            <GiftForm key={session} />
          </Suspense>
        ) : null}
      </Dialog>
    </>
  );
}
