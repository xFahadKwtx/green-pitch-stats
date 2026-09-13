/**
 * Anonymous suggestion / complaint delivery.
 *
 * Privacy rules enforced here:
 * - The email body contains only the visitor's message plus a server timestamp.
 * - No visitor identity, auth data, user agent, or raw IP is ever included or stored.
 * - Rate limiting uses a salted, truncated in-memory hash of the caller address,
 *   which is never persisted and cannot be reversed into an address.
 */

import { createHash } from "node:crypto";

export const FEEDBACK_RECIPIENT = "almustatilalakhdar@gmail.com";
export const FEEDBACK_MIN_LENGTH = 1;
export const FEEDBACK_MAX_LENGTH = 2000;

/** Per-window limits (in-memory only, per server instance). */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 3;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const MAX_GLOBAL_PER_WINDOW = 60;

export type FeedbackFailure =
  | "empty"
  | "too_long"
  | "rate_limited"
  | "spam"
  | "email_not_configured"
  | "send_failed";

export type FeedbackResult = { ok: true } | { ok: false; reason: FeedbackFailure };

const buckets = new Map<string, number[]>();
const globalHits: number[] = [];
const salt = createHash("sha256").update(`maa-feedback-${process.uptime()}`).digest("hex");

function prune(list: number[], now: number, windowMs: number) {
  while (list.length > 0 && now - list[0]! > windowMs) list.shift();
}

function callerKey(headers: Headers | undefined): string {
  const raw =
    headers?.get("cf-connecting-ip") ??
    headers?.get("x-real-ip") ??
    headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  // Salted + truncated: enough to group repeat senders, never a stored address.
  return createHash("sha256").update(`${salt}:${raw}`).digest("hex").slice(0, 16);
}

/** True when the caller is inside both the per-caller and the global allowance. */
export function allowFeedback(headers?: Headers, now = Date.now()): boolean {
  prune(globalHits, now, GLOBAL_WINDOW_MS);
  if (globalHits.length >= MAX_GLOBAL_PER_WINDOW) return false;

  const key = callerKey(headers);
  const list = buckets.get(key) ?? [];
  prune(list, now, WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) {
    buckets.set(key, list);
    return false;
  }
  list.push(now);
  buckets.set(key, list);
  globalHits.push(now);
  return true;
}

/** Test-only reset of the in-memory counters. */
export function resetFeedbackLimits() {
  buckets.clear();
  globalHits.length = 0;
}

/** Strips control characters that could be used for header injection. */
export function sanitizeMessage(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sends the anonymous message to the single fixed recipient.
 * The recipient is never accepted from the caller.
 */
export async function sendFeedbackEmail(message: string): Promise<FeedbackResult> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  const senderDomain = process.env["EMAIL_SENDER_DOMAIN"];
  if (!apiKey || !senderDomain) return { ok: false, reason: "email_not_configured" };

  const sentAt = new Date().toISOString();
  const text = `Anonymous suggestion / complaint\nReceived: ${sentAt}\n\n${message}\n`;
  const html = `<p><strong>Anonymous suggestion / complaint</strong></p><p>Received: ${escapeHtml(
    sentAt,
  )}</p><pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(message)}</pre>`;

  try {
    const { sendLovableEmail } = await import("@lovable.dev/email-js");
    await sendLovableEmail(
      {
        to: FEEDBACK_RECIPIENT,
        from: `Al-Mustatil Al-Akhdar <noreply@${senderDomain}>`,
        sender_domain: senderDomain,
        subject: "Anonymous suggestion / complaint",
        text,
        html,
      },
      { apiKey },
    );
    return { ok: true };
  } catch {
    // Never surface upstream detail to the visitor.
    return { ok: false, reason: "send_failed" };
  }
}

/** Full server-side pipeline: validate, spam-check, rate-limit, send. */
export async function submitFeedback(
  input: { message: unknown; trap?: unknown },
  headers?: Headers,
): Promise<FeedbackResult> {
  if (sanitizeMessage(input.trap).length > 0) return { ok: false, reason: "spam" };

  const message = sanitizeMessage(input.message);
  if (message.length < FEEDBACK_MIN_LENGTH) return { ok: false, reason: "empty" };
  if (message.length > FEEDBACK_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (!allowFeedback(headers)) return { ok: false, reason: "rate_limited" };

  return sendFeedbackEmail(message);
}
