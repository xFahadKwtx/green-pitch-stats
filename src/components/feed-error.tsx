import { useI18n } from "@/lib/i18n";

/**
 * M1: the only error surface used by public feed routes. It intentionally
 * ignores the router's error object so no upstream/internal text can render.
 */
export function FeedErrorNotice() {
  const { t } = useI18n();
  return (
    <div role="alert" className="p-8 text-center text-muted-foreground">
      {t("error.generic")}
    </div>
  );
}
