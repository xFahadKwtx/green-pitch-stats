import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetFeedbackLimits, sendFeedbackEmail } from "../src/lib/feedback.server";

const CANARY = "شكوى سرية من لاعب canary-secret-12345";
const PROVIDER_TEXT = "Please verify your account email address before receiving submissions";

let logs: unknown[] = [];
let errorSpy: { mockRestore: () => void } | undefined;
const originalFetch = globalThis.fetch;

function stubFetch(impl: () => Promise<Response>) {
  globalThis.fetch = impl as unknown as typeof fetch;
}

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serialized(): string {
  return JSON.stringify(logs);
}

beforeEach(() => {
  logs = [];
  resetFeedbackLimits();
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(...args);
  });
});

afterEach(() => {
  errorSpy?.mockRestore();
  globalThis.fetch = originalFetch;
});

describe("feedback failure diagnostics", () => {
  test("maps a pending email-verification rejection to verification_required", async () => {
    stubFetch(async () =>
      jsonResponse(200, { ok: false, errors: [{ code: "EMAIL_NOT_VERIFIED", message: PROVIDER_TEXT }] }),
    );
    const result = await sendFeedbackEmail(CANARY);
    expect(result).toEqual({ ok: false, reason: "provider_rejected" });
    expect(logs).toHaveLength(1);
    const line = logs[0] as Record<string, unknown>;
    expect(line["event"]).toBe("feedback_submit_failure");
    expect(line["category"]).toBe("provider-rejected");
    expect(line["code"]).toBe("verification_required");
    expect(line["status"]).toBe(200);
    expect(line["contentClass"]).toBe("json");
    expect(typeof line["elapsedMs"]).toBe("number");
    expect(typeof line["at"]).toBe("string");
    expect(typeof line["ref"]).toBe("string");
  });

  test("never leaks the message, recipient or upstream text", async () => {
    stubFetch(async () => jsonResponse(200, { ok: false, errors: [{ message: PROVIDER_TEXT }] }));
    await sendFeedbackEmail(CANARY);
    const dump = serialized();
    expect(dump).not.toContain("canary-secret-12345");
    expect(dump).not.toContain("شكوى");
    expect(dump).not.toContain("almustatilalakhdar");
    expect(dump).not.toContain("formspree");
    expect(dump).not.toContain("verify your account");
    expect(Object.keys(logs[0] as object).sort()).toEqual([
      "at",
      "category",
      "code",
      "contentClass",
      "elapsedMs",
      "event",
      "ref",
      "status",
    ]);
  });

  test("classifies an HTTP 403 HTML challenge as blocked_or_challenge", async () => {
    stubFetch(
      async () =>
        new Response("<html><title>Attention Required! | Cloudflare</title></html>", {
          status: 403,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const result = await sendFeedbackEmail("hello");
    expect(result).toEqual({ ok: false, reason: "provider_rejected" });
    const line = logs[0] as Record<string, unknown>;
    expect(line["category"]).toBe("upstream-http");
    expect(line["code"]).toBe("blocked_or_challenge");
    expect(line["status"]).toBe(403);
    expect(line["contentClass"]).toBe("html");
    expect(serialized()).not.toContain("Cloudflare");
  });

  test("classifies rate limiting, spam blocks and invalid requests", async () => {
    const cases: Array<[Response, string, string]> = [
      [new Response("Too many requests", { status: 429 }), "rate_limited", "upstream-http"],
      [
        jsonResponse(200, { ok: false, errors: [{ code: "SPAM", message: "Blocked as spam" }] }),
        "captcha_required",
        "provider-rejected",
      ],
      [
        jsonResponse(422, { errors: [{ field: "message", message: "Bad request" }] }),
        "invalid_request",
        "upstream-http",
      ],
      [new Response("nope", { status: 500 }), "provider_rejected_unknown", "upstream-http"],
      [jsonResponse(200, { ok: false }), "provider_rejected_unknown", "provider-rejected"],
    ];
    for (const [response, code, category] of cases) {
      logs = [];
      stubFetch(async () => response);
      const result = await sendFeedbackEmail("hello");
      expect(result).toEqual({ ok: false, reason: "provider_rejected" });
      const line = logs[0] as Record<string, unknown>;
      expect(line["code"]).toBe(code);
      expect(line["category"]).toBe(category);
    }
  });

  test("logs invalid_json for an unparsable success response", async () => {
    stubFetch(async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }));
    const result = await sendFeedbackEmail("hello");
    expect(result).toEqual({ ok: false, reason: "send_failed" });
    const line = logs[0] as Record<string, unknown>;
    expect(line["category"]).toBe("invalid-response");
    expect(line["code"]).toBe("invalid_json");
  });

  test("logs fixed codes for timeouts and network errors", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    stubFetch(async () => { throw timeout; });
    await sendFeedbackEmail("hello");
    expect((logs[0] as Record<string, unknown>)["code"]).toBe("timeout");
    expect((logs[0] as Record<string, unknown>)["category"]).toBe("timeout");
    expect(serialized()).not.toContain("aborted");

    logs = [];
    stubFetch(async () => { throw new TypeError("fetch failed to secret.host"); });
    await sendFeedbackEmail("hello");
    expect((logs[0] as Record<string, unknown>)["code"]).toBe("network");
    expect((logs[0] as Record<string, unknown>)["category"]).toBe("network");
    expect(serialized()).not.toContain("secret.host");
  });

  test("logs nothing on a successful submission", async () => {
    stubFetch(async () => jsonResponse(200, { ok: true, next: "https://formspree.io/thanks" }));
    const result = await sendFeedbackEmail(CANARY);
    expect(result).toEqual({ ok: true, activationPending: false });
    expect(logs).toHaveLength(0);
  });
});
