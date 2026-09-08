/**
 * M1: server-side boundary for public read-only feeds.
 *
 * Successful values pass through untouched (same reference). Failures are
 * logged as an allowlisted, bounded structured line and rethrown as a
 * sanitized public error — no upstream body, header, URL, credential, cause or
 * stack can reach the visitor.
 */

import { createPublicError } from "./public-error";

type FeedSource = "players" | "records" | "store" | "upcoming-games";

type Category = "rate-limited" | "upstream-http" | "upstream-shape" | "unavailable" | "unknown";

/** Only these fields are ever logged. Never arbitrary upstream strings. */
interface SafeLogFields {
  event: "public_feed_error";
  source: FeedSource;
  stage: "public-feed";
  category: Category;
  status: number | null;
  ref: string;
}

function categorize(error: unknown): { category: Category; status: number | null } {
  if (!(error instanceof Error)) return { category: "unknown", status: null };

  const name = error.name;
  if (name === "AirtableRateLimitError") return { category: "rate-limited", status: 429 };
  if (name === "FeedUnavailableError") return { category: "unavailable", status: null };

  const candidate = (error as { status?: unknown; statusCode?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;
  if (typeof candidate === "number" && Number.isInteger(candidate)) {
    return { category: "upstream-http", status: candidate };
  }
  if (name === "TypeError") return { category: "unavailable", status: null };
  return { category: "unknown", status: null };
}

function reference(): string {
  const random = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `${Date.now().toString(36)}-${random}`;
}

/**
 * Wraps a public feed read. Correlation reference is log-only; it is never
 * included in the visitor-facing message.
 */
export async function withPublicFeedBoundary<T>(
  source: FeedSource,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const { category, status } = categorize(error);
    const fields: SafeLogFields = {
      event: "public_feed_error",
      source,
      stage: "public-feed",
      category,
      status,
      ref: reference(),
    };
    // A plain string keeps arbitrary Error internals out of the log pipeline.
    console.error(JSON.stringify(fields));
    throw createPublicError();
  }
}
