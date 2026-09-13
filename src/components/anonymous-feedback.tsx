import { useServerFn } from "@tanstack/react-start";
import { Loader2, Send } from "lucide-react";
import { useState } from "react";

import { sendFeedback, type FeedbackReason } from "@/lib/feedback.functions";
import { useI18n, type TKey } from "@/lib/i18n";

const MAX_LENGTH = 2000;

const ERROR_KEYS: Record<FeedbackReason, TKey> = {
  empty: "feedback.error.empty",
  too_long: "feedback.error.tooLong",
  rate_limited: "feedback.error.rate",
  spam: "feedback.error.failed",
  send_failed: "feedback.error.failed",
  provider_rejected: "feedback.error.failed",
};

/** Anonymous suggestion / complaint form. No identity fields, ever. */
export function AnonymousFeedback() {
  const { t } = useI18n();
  const submit = useServerFn(sendFeedback);
  const [message, setMessage] = useState("");
  const [trap, setTrap] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<TKey | null>(null);

  const sending = state === "sending";

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    if (message.trim().length === 0) {
      setError("feedback.error.empty");
      setState("idle");
      return;
    }
    setError(null);
    setState("sending");
    try {
      const result = await submit({ data: { message, trap } });
      if (result.ok) {
        setMessage("");
        setState("sent");
        return;
      }
      setError(ERROR_KEYS[result.reason] ?? "feedback.error.failed");
      setState("idle");
    } catch {
      setError("feedback.error.failed");
      setState("idle");
    }
  }

  return (
    <section className="glass-card mt-10 p-5 sm:p-7">
      <h2 className="text-xl font-bold tracking-wide uppercase sm:text-2xl">
        <span className="me-3 inline-block h-4 w-1.5 translate-y-0.5 rounded-full bg-gold align-middle" aria-hidden />
        {t("feedback.title")}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t("feedback.privacy")}</p>

      <form className="mt-5" onSubmit={onSubmit} noValidate>
        <label htmlFor="feedback-message" className="sr-only">
          {t("feedback.label")}
        </label>
        <textarea
          id="feedback-message"
          name="message"
          rows={5}
          maxLength={MAX_LENGTH}
          value={message}
          disabled={sending}
          onChange={(e) => {
            setMessage(e.target.value);
            if (state === "sent") setState("idle");
          }}
          placeholder={t("feedback.placeholder")}
          className="w-full resize-y rounded-2xl border border-border bg-background/40 p-4 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus:border-gold/60 disabled:opacity-70 sm:text-base"
        />

        {/* Honeypot: hidden from humans and assistive tech, filled only by bots. */}
        <div className="hidden" aria-hidden>
          <input
            type="text"
            name="company"
            tabIndex={-1}
            autoComplete="off"
            value={trap}
            onChange={(e) => setTrap(e.target.value)}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={sending}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-gold px-6 text-sm font-semibold text-primary-foreground shadow-gold transition-opacity disabled:opacity-60"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Send className="h-4 w-4" aria-hidden />
            )}
            {sending ? t("feedback.sending") : t("feedback.send")}
          </button>
          <span className="text-xs text-muted-foreground" aria-hidden>
            {message.trim().length}/{MAX_LENGTH}
          </span>
        </div>

        <div aria-live="polite" className="min-h-6">
          {state === "sent" ? (
            <p className="mt-3 text-sm font-semibold text-gold">{t("feedback.success")}</p>
          ) : null}
          {error ? (
            <p className="mt-3 text-sm font-semibold text-destructive">{t(error)}</p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
