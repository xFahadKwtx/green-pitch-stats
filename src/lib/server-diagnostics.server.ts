/** M1: bounded metadata only. Never copy arbitrary error text into logs. */
const SOURCES = ["players", "records", "store", "upcoming-games", "airtable", "request", "server"] as const;
const STAGES = ["public-feed", "request", "network", "response", "response-json", "response-shape", "capture"] as const;
type Source = (typeof SOURCES)[number];
type Stage = (typeof STAGES)[number];
const trustedRecords = new WeakMap<object, string>();

export function safeHttpStatus(error: unknown): number | null {
  try {
    if (!error || typeof error !== "object") return null;
    const value = (error as { statusCode?: unknown }).statusCode ?? (error as { status?: unknown }).status;
    return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : null;
  } catch {
    return null;
  }
}

/** Coarse, allowlisted failure kinds carried as bounded error metadata. */
const KINDS = new Set(["timeout", "network", "upstream-http", "invalid-response", "unknown"]);

function safeKind(error: unknown): string | null {
  try {
    if (!error || typeof error !== "object") return null;
    const kind = (error as { kind?: unknown }).kind;
    return typeof kind === "string" && KINDS.has(kind) ? kind : null;
  } catch {
    return null;
  }
}

function category(error: unknown, status: number | null): string {
  if (status === 429) return "rate-limited";
  if (status !== null) return "upstream-http";
  try {
    const name = error && typeof error === "object" ? (error as { name?: unknown }).name : null;
    if (name === "AirtableRateLimitError") return "rate-limited";
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
    if (name === "TypeError") return "network";
    // Bounded metadata keeps timeout/network/HTTP distinguishable after the
    // coordinator layer converts a transport failure into a generic error.
    if (name === "FeedUnavailableError") return safeKind(error) ?? "unavailable";
  } catch {
    // Accessors/proxies are untrusted too.
  }
  return safeKind(error) ?? "unknown";
}

function project(source: Source, stage: Stage, error: unknown, httpStatus?: number): string {
  const status = safeHttpStatus({ status: httpStatus }) ?? safeHttpStatus(error);
  return JSON.stringify({
    event: "server_error",
    source: SOURCES.includes(source) ? source : "server",
    stage: STAGES.includes(stage) ? stage : "capture",
    category: stage === "response-json" || stage === "response-shape" ? "invalid-response" : category(error, status),
    status,
    ref: crypto.randomUUID(),
  });
}

/** Arbitrary arguments are omitted. Only internally branded records retain metadata. */
export function describeDiagnostic(value: unknown): string {
  try {
    if (value && typeof value === "object") {
      const trusted = trustedRecords.get(value);
      if (trusted !== undefined) return trusted;
    }
    return project("server", "capture", value);
  } catch {
    return '{"event":"server_error","source":"server","category":"unknown"}';
  }
}

/** Logging is best-effort and must never replace the caller's public error. */
export function logServerError(source: Source, stage: Stage, error?: unknown, httpStatus?: number): void {
  try {
    const line = project(source, stage, error, httpStatus);
    const record = Object.freeze(JSON.parse(line) as Record<string, unknown>);
    trustedRecords.set(record, line);
    console.error(record);
  } catch {
    // A failed logging sink must not disclose a second error.
  }
}

/** Fixed phases of a scheduled warming attempt. */
export const WARM_PHASES = ["claim", "refresh"] as const;
export type WarmPhase = (typeof WARM_PHASES)[number];
const WARM_FEEDS_LOGGED = ["players", "store"] as const;

/**
 * One bounded, sanitized line per failed scheduled warming attempt. Only fixed
 * allowlisted values are emitted: no message, stack, URL, token, header, SQL
 * argument, payload, upstream body or user data. Never throws.
 */
export function logScheduledWarmFailure(feed: string, phase: WarmPhase, error?: unknown): void {
  try {
    const status = safeHttpStatus(error);
    const line = JSON.stringify({
      event: "scheduled_warm_failure",
      feed: (WARM_FEEDS_LOGGED as readonly string[]).includes(feed) ? feed : "other",
      phase: (WARM_PHASES as readonly string[]).includes(phase) ? phase : "refresh",
      category: category(error, status),
      status,
      timeout: category(error, status) === "timeout",
      at: new Date().toISOString(),
      ref: crypto.randomUUID(),
    });
    const record = Object.freeze(JSON.parse(line) as Record<string, unknown>);
    trustedRecords.set(record, line);
    console.error(record);
  } catch {
    // A failed logging sink must never affect the warming response.
  }
}

/** Fixed, allowlisted technical reason codes for a feedback submission failure. */
export const FEEDBACK_REASON_CODES = [
  "origin_required",
  "activation_required",
  "verification_required",
  "captcha_required",
  "rate_limited",
  "blocked_or_challenge",
  "invalid_request",
  "invalid_json",
  "timeout",
  "network",
  "provider_rejected_unknown",
] as const;
export type FeedbackReasonCode = (typeof FEEDBACK_REASON_CODES)[number];

const FEEDBACK_CATEGORIES = ["upstream-http", "invalid-response", "timeout", "network", "provider-rejected"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

const FEEDBACK_CONTENT_CLASSES = ["json", "html", "other", "none"] as const;
export type FeedbackContentClass = (typeof FEEDBACK_CONTENT_CLASSES)[number];

/**
 * One bounded line per failed anonymous-feedback submission. Only fixed
 * allowlisted values are emitted: never the visitor's message, the recipient
 * address, upstream body text, error messages, URLs, headers, IP or user agent.
 * Unknown inputs collapse to fixed unknown codes. Never throws.
 */
export function logFeedbackFailure(input: {
  category: string;
  code: string;
  status?: number | null;
  contentClass?: string;
  elapsedMs?: number;
}): void {
  try {
    const status = typeof input.status === "number" && Number.isInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : null;
    const elapsed = typeof input.elapsedMs === "number" && Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0 ? Math.round(input.elapsedMs) : null;
    const line = JSON.stringify({
      event: "feedback_submit_failure",
      category: (FEEDBACK_CATEGORIES as readonly string[]).includes(input.category) ? input.category : "provider-rejected",
      code: (FEEDBACK_REASON_CODES as readonly string[]).includes(input.code) ? input.code : "provider_rejected_unknown",
      status,
      contentClass: (FEEDBACK_CONTENT_CLASSES as readonly string[]).includes(input.contentClass ?? "") ? input.contentClass : "other",
      elapsedMs: elapsed,
      at: new Date().toISOString(),
      ref: crypto.randomUUID(),
    });
    const record = Object.freeze(JSON.parse(line) as Record<string, unknown>);
    trustedRecords.set(record, line);
    console.error(record);
  } catch {
    // A failed logging sink must never affect the visitor's response.
  }
}
