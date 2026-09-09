import { isNotFound } from "@tanstack/react-router";
import { HTTPError, HTTPResponse } from "h3";
import { createPublicError } from "./public-error";
import { renderErrorPage } from "./error-page";
import { logServerError, safeHttpStatus } from "./server-diagnostics.server";

type FeedSource = "players" | "records" | "store" | "upcoming-games";

/** Preserve framework control flow by identity, including headers, body and routing metadata. */
function isControlFlow(value: unknown): boolean {
  try {
    // TanStack redirects are Responses. h3 also has its own response container.
    if (value instanceof Response || value instanceof HTTPResponse || isNotFound(value)) return true;
    // Handled HTTPError instances are intentional HTTP outcomes. Unhandled errors are internal.
    return value instanceof HTTPError && value.unhandled !== true;
  } catch {
    return false;
  }
}

/** Status alone never makes an error intentional. Do not copy its data or headers. */
function publicHttpError(error: unknown): Error | null {
  try {
    if (!error || typeof error !== "object" || !("statusCode" in error)) return null;
    const safe = createPublicError();
    Object.defineProperty(safe, "statusCode", { value: safeHttpStatus(error) ?? 500 });
    return safe;
  } catch {
    return null;
  }
}

/** Runs outside H2: all fresh, refreshed and fallback payloads pass through unchanged. */
export async function withPublicFeedBoundary<T>(source: FeedSource, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isControlFlow(error)) throw error;
    logServerError(source, "public-feed", error);
    throw createPublicError();
  }
}

/** Request middleware error handling; successful/intentional responses remain untouched. */
export async function withPublicRequestBoundary<T>(run: () => T | Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (error) {
    if (isControlFlow(error)) throw error;
    logServerError("request", "request", error);
    const httpError = publicHttpError(error);
    if (httpError) throw httpError;
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}
