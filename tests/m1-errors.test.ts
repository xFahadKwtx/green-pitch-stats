/**
 * M1 focused tests — public error boundary sanitization.
 *
 * All network is mocked; any unmocked request throws. No real Airtable,
 * coordinator or database traffic occurs.
 *   bun test tests/m1-errors.test.ts
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import {
  PUBLIC_ERROR_MESSAGE,
  PUBLIC_ERROR_NAME,
  createPublicError,
  isPublicError,
} from "../src/lib/public-error";
import { withPublicFeedBoundary } from "../src/lib/public-error.server";
import { FeedErrorNotice } from "../src/components/feed-error";
import { I18nProvider } from "../src/lib/i18n";

process.env["LOVABLE_API_KEY"] = "dummy-lovable-key";
process.env["AIRTABLE_API_KEY"] = "dummy-airtable-key";

const SECRETS = [
  "dummy-lovable-key",
  "dummy-airtable-key",
  "sb_secret",
  "Bearer",
  "Authorization",
  "connector-gateway.lovable.dev",
  "appd0pg0uKI1fSTOx",
  "INVALID_REQUEST_UNKNOWN",
  "supabase",
  "postgres",
];

/** Complete serialized surface of a thrown error, as a visitor could see it. */
function surface(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 6 && current != null; i++) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    parts.push(current.name, current.message, current.stack ?? "");
    for (const key of Object.getOwnPropertyNames(current)) {
      parts.push(key, String((current as unknown as Record<string, unknown>)[key]));
    }
    parts.push(JSON.stringify(current, Object.getOwnPropertyNames(current)));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join("|");
}

function expectSafe(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  const e = error as Error;
  expect(e.name).toBe(PUBLIC_ERROR_NAME);
  expect(e.message).toBe(PUBLIC_ERROR_MESSAGE);
  expect(e.stack).toBe("");
  expect((e as { cause?: unknown }).cause).toBeUndefined();
  expect(Object.keys(e)).toEqual([]);
  const text = surface(e);
  for (const secret of SECRETS) {
    expect(text.includes(secret)).toBe(false);
  }
}

// --- network lockdown -------------------------------------------------------
const realFetch = globalThis.fetch;
let fetchResponder: ((url: string) => Promise<Response>) | null = null;
let logged: unknown[][] = [];
const realConsoleError = console.error;

beforeEach(() => {
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  globalThis.fetch = (async (input: unknown) => {
    const url = String(
      typeof input === "string" ? input : (input as { url?: string }).url ?? input,
    );
    if (!fetchResponder) throw new Error(`Unmocked network call blocked: ${url}`);
    return fetchResponder(url);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
  fetchResponder = null;
});

/** listAirtableRecords with the H2 coordinator stubbed to a direct pass-through. */
async function loadAirtableHelperWithStubbedCoordinator() {
  class AirtableRateLimitError extends Error {
    retryAfterSeconds: number | null;
    constructor(retryAfterSeconds: number | null) {
      super("Airtable rate limited");
      this.name = "AirtableRateLimitError";
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
  await mock.module("../src/lib/public-feed-cache.server", () => ({
    AirtableRateLimitError,
    runAirtablePage: async (
      _tableId: string,
      _key: string,
      run: (signal: AbortSignal) => Promise<unknown>,
    ) => run(new AbortController().signal),
  }));
  const mod = await import("../src/lib/airtable.server?m1");
  return { listAirtableRecords: mod.listAirtableRecords, AirtableRateLimitError };
}

function httpResponder(status: number, body: string, headers: Record<string, string> = {}) {
  return async () =>
    new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
}

const TECHNICAL_BODY = JSON.stringify({
  error: {
    type: "INVALID_REQUEST_UNKNOWN",
    message: "Field 'Secret Column' does not exist in table appd0pg0uKI1fSTOx",
  },
});

describe("M1 — public error boundary", () => {
  test("1. Airtable 400 with a technical body yields only the generic public error", async () => {
    const { listAirtableRecords } = await loadAirtableHelperWithStubbedCoordinator();
    fetchResponder = httpResponder(400, TECHNICAL_BODY);
    let caught: unknown;
    try {
      await withPublicFeedBoundary("players", () => listAirtableRecords("tblTest"));
    } catch (error) {
      caught = error;
    }
    expectSafe(caught);
    expect(surface(caught).includes("Secret Column")).toBe(false);
  });

  test("2. Airtable 401 and 403 expose no credentials or integration details", async () => {
    const { listAirtableRecords } = await loadAirtableHelperWithStubbedCoordinator();
    for (const status of [401, 403]) {
      fetchResponder = httpResponder(
        status,
        JSON.stringify({ error: "AUTHENTICATION_REQUIRED", key: "dummy-airtable-key" }),
      );
      let caught: unknown;
      try {
        await withPublicFeedBoundary("store", () => listAirtableRecords("tblTest"));
      } catch (error) {
        caught = error;
      }
      expectSafe(caught);
    }
  });

  test("3. Airtable 429 keeps the typed rate-limit contract and a sanitized public message", async () => {
    const { listAirtableRecords, AirtableRateLimitError } =
      await loadAirtableHelperWithStubbedCoordinator();
    fetchResponder = httpResponder(429, "{}", { "retry-after": "120" });

    // The helper still throws the typed error H2 uses for cooldown handling.
    let raw: unknown;
    try {
      await listAirtableRecords("tblTest");
    } catch (error) {
      raw = error;
    }
    expect(raw).toBeInstanceOf(AirtableRateLimitError);
    expect((raw as { retryAfterSeconds: number }).retryAfterSeconds).toBe(120);

    let caught: unknown;
    try {
      await withPublicFeedBoundary("records", () => listAirtableRecords("tblTest"));
    } catch (error) {
      caught = error;
    }
    expectSafe(caught);
  });

  test("4. Airtable 500 and 503 are sanitized", async () => {
    const { listAirtableRecords } = await loadAirtableHelperWithStubbedCoordinator();
    for (const status of [500, 503]) {
      fetchResponder = httpResponder(status, "<html>nginx upstream 10.0.0.4</html>");
      let caught: unknown;
      try {
        await withPublicFeedBoundary("upcoming-games", () => listAirtableRecords("tblTest"));
      } catch (error) {
        caught = error;
      }
      expectSafe(caught);
      expect(surface(caught).includes("10.0.0.4")).toBe(false);
    }
  });

  test("5. Network rejection is sanitized", async () => {
    const { listAirtableRecords } = await loadAirtableHelperWithStubbedCoordinator();
    fetchResponder = async () => {
      throw new TypeError("fetch failed: ECONNRESET connector-gateway.lovable.dev");
    };
    let caught: unknown;
    try {
      await withPublicFeedBoundary("players", () => listAirtableRecords("tblTest"));
    } catch (error) {
      caught = error;
    }
    expectSafe(caught);
  });

  test("6. Timeout / abort is sanitized", async () => {
    let caught: unknown;
    try {
      await withPublicFeedBoundary("players", async () => {
        const error = new Error("The operation timed out after 45000ms at https://connector-gateway.lovable.dev/airtable");
        error.name = "TimeoutError";
        throw error;
      });
    } catch (error) {
      caught = error;
    }
    expectSafe(caught);
  });

  test("7. Unexpected error with custom properties, cause and stack is fully stripped", async () => {
    let caught: unknown;
    try {
      await withPublicFeodBoundaryShim();
    } catch (error) {
      caught = error;
    }
    expectSafe(caught);
  });

  async function withPublicFeodBoundaryShim() {
    return withPublicFeedBoundary("store", async () => {
      const inner = new Error("postgres: password authentication failed for user sb_secret");
      const outer = new Error(
        "Airtable INVALID_REQUEST_UNKNOWN at https://connector-gateway.lovable.dev/airtable with Authorization Bearer dummy-lovable-key",
        { cause: inner },
      );
      Object.assign(outer, {
        apiKey: "dummy-airtable-key",
        requestUrl: "https://connector-gateway.lovable.dev/airtable",
        responseBody: TECHNICAL_BODY,
        status: 400,
      });
      throw outer;
    });
  }

  test("8. Successful reads pass through with identical value and no log output", async () => {
    const payload = [{ id: "rec1", nested: { a: 1 } }];
    const result = await withPublicFeedBoundary("players", async () => payload);
    expect(result).toBe(payload);
    expect(logged.length).toBe(0);
  });

  test("server log line is bounded, allowlisted and secret-free", async () => {
    try {
      await withPublicFeodBoundaryShim();
    } catch {
      /* expected */
    }
    expect(logged.length).toBe(1);
    const args = logged[0] as unknown[];
    expect(args.length).toBe(1);
    expect(typeof args[0]).toBe("string");
    const parsed = JSON.parse(args[0] as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "category",
      "event",
      "ref",
      "source",
      "stage",
      "status",
    ]);
    expect(parsed["source"]).toBe("store");
    expect(parsed["category"]).toBe("upstream-http");
    expect(parsed["status"]).toBe(400);
    expect(typeof parsed["ref"]).toBe("string");
    for (const secret of SECRETS) {
      expect((args[0] as string).includes(secret)).toBe(false);
    }
  });

  test("createPublicError is recognisable and stable", () => {
    const a = createPublicError();
    const b = createPublicError();
    expect(a.message).toBe(b.message);
    expect(isPublicError(a)).toBe(true);
    expect(isPublicError(new Error("boom"))).toBe(false);
  });
});

describe("M1 — public rendering", () => {
  test("9. the shared notice renders the generic message only (EN)", () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(FeedErrorNotice)),
    );
    expect(html.includes("temporarily unavailable")).toBe(true);
    for (const secret of SECRETS) {
      expect(html.includes(secret)).toBe(false);
    }
    expect(html.includes("role=\"alert\"")).toBe(true);
  });

  test("EN and AR generic messages exist and are free of technical detail", async () => {
    const source = await Bun.file("src/lib/i18n.tsx").text();
    const matches = [...source.matchAll(/"error\.generic": "([^"]+)"/g)].map((m) => m[1] as string);
    expect(matches.length).toBe(2);
    expect(matches[1]).toMatch(/[\u0600-\u06FF]/);
    for (const message of matches) {
      for (const secret of SECRETS) {
        expect(message.includes(secret)).toBe(false);
      }
      expect(message).not.toMatch(/airtable|http|status|error code/i);
    }
  });

  test("10/11. no public route renders a server-originated error message", async () => {
    const files = [
      "src/routes/players.index.tsx",
      "src/routes/players.$playerId.tsx",
      "src/routes/compare.tsx",
      "src/routes/leaderboard.tsx",
      "src/routes/records.tsx",
      "src/routes/store.tsx",
      "src/routes/upcoming-games.tsx",
      "src/routes/__root.tsx",
    ];
    for (const file of files) {
      const source = await Bun.file(file).text();
      expect(source.includes("error.message")).toBe(false);
      expect(source.includes("{error.stack")).toBe(false);
    }
  });
});
