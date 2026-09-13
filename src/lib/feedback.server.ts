/**
 * Anonymous suggestion / complaint delivery via FormSubmit (AJAX endpoint).
 *
 * Privacy rules enforced here:
 * - Only the visitor's message, a fixed subject and the canonical form URL are sent.
 * - No visitor identity, auth data, user agent, referrer or IP is forwarded or stored.
 * - The recipient address lives only in this server-only module, never in the browser.
 * - Rate limiting uses a crypto-random salted, truncated in-memory hash of the caller
 *   address; buckets are purged once expired so no pseudonym is retained.
 */

import { createHash, randomBytes } from "node:crypto";

export const FEEDBACK_RECIPIENT = "almustatilalakhdar@gmail.com";
export const FEEDBACK_MIN_LENGTH = 1;
export const FEEDBACK_MAX_LENGTH = 2000;
export const FEEDBACK_SUBJECT = "اقتراح أو شكوى مجهولة — المستطيل الأخضر";
export const FEEDBACK_FORM_URL = "https://almustatil.lovable.app/contact";
export const FEEDBACK_ENDPOINT = `https://formsubmit.co/ajax/${FEEDBACK_RECIPIENT}`;
export const FEEDBACK_TIMEOUT_MS = 15_000;

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
  | "provider_rejected"
  | "send_failed";

export type FeedbackResult =
  | { ok: true; activationPending: boolean }
  | { ok: false; reason: FeedbackFailure };

const buckets = new Map<string, number[]>();
const globalHits: number[] = [];
const salt = randomBytes(32).toString("hex");

function prune(list: number[], now: number, windowMs: number) {
  while (list.length > 0 && now - list[0]! > windowMs) list.shift();
}

/** Drops fully expired buckets so hashed caller keys are not retained. */
function purgeBuckets(now: number) {
  for (const [key, list] of buckets) {
    prune(list, now, WINDOW_MS);
    if (list.length === 0) buckets.delete(key);
  }
}

function callerKey(headers: Headers | undefined): string {
  const raw =
    headers?.get("cf-connecting-ip") ??
    headers?.get("x-real-ip") ??
    headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  // Salted with a per-process random value + truncated: groups repeat senders only.
  return createHash("sha256").update(`${salt}:${raw}`).digest("hex").slice(0, 16);
}

/** True when the caller is inside both the per-caller and the global allowance. */
export function allowFeedback(headers?: Headers, now = Date.now()): boolean {
  purgeBuckets(now);
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

/** Strips control characters that could be used for header/content injection. */
export function sanitizeMessage(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function isTrue(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.toLowerCase() === "true");
}

/** Detects the provider's "form not activated yet" response. */
function looksLikeActivation(message: unknown): boolean {
  if (typeof message !== "string") return false;
  const text = message.toLowerCase();
  return (
    text.includes("activat") ||
    text.includes("confirm") ||
    text.includes("verify") ||
    text.includes("check your inbox")
  );
}

/**
 * Posts the anonymous message to the single fixed recipient's form endpoint.
 * The recipient is never accepted from the caller.
 */
export async function sendFeedbackEmail(message: string): Promise<FeedbackResult> {
  const body = {
    message,
    _subject: FEEDBACK_SUBJECT,
    _template: "table",
    _captcha: "false",
    _url: FEEDBACK_FORM_URL,
  };

  let response: Response;
  try {
    response = await fetch(FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Our own site identity, required by the provider to accept the submission.
        // Never the visitor's own origin, referrer, address or user agent.
        Origin: FEEDBACK_SITE_ORIGIN,
        Referer: FEEDBACK_FORM_URL,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
      referrerPolicy: "no-referrer",
    });
  } catch {
    // Network failure or timeout. Never surface upstream detail to the visitor.
    return { ok: false, reason: "send_failed" };
  }

  if (!response.ok) return { ok: false, reason: "provider_rejected" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "send_failed" };
  }

  if (!payload || typeof payload !== "object") return { ok: false, reason: "send_failed" };
  const record = payload as Record<string, unknown>;
  const activation = looksLikeActivation(record["message"]);

  // The provider answers success:"false" with an activation notice until the
  // mailbox owner confirms the form; the submission itself is stored (30 days).
  if (!isTrue(record["success"]) && !activation) {
    return { ok: false, reason: "provider_rejected" };
  }

  // Accepted receipt. Not proof of inbox delivery.
  return { ok: true, activationPending: activation };
}


/** Full server-side pipeline: validate, spam-check, rate-limit, submit. */
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
