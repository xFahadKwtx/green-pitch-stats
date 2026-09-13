import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  FEEDBACK_ENDPOINT,
  FEEDBACK_FORM_URL,
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_RECIPIENT,
  FEEDBACK_SUBJECT,
  resetFeedbackLimits,
  sanitizeMessage,
  submitFeedback,
} from "../src/lib/feedback.server";

const realFetch = globalThis.fetch;

interface Call {
  url: string;
  init: RequestInit;
}

const calls: Call[] = [];

function mockFetch(handler: () => Promise<Response> | Response) {
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler();
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  resetFeedbackLimits();
  calls.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("anonymous feedback", () => {
  test("endpoint is the fixed provider form, recipient stays server-side", () => {
    expect(FEEDBACK_RECIPIENT).toBe("almustatilalakhdar@gmail.com");
    expect(FEEDBACK_ENDPOINT).toBe("https://formspree.io/f/xkjnlqyn");
    expect(FEEDBACK_FORM_URL).toBe("https://almustatil.lovable.app/contact");
  });

  test("accepted submission reports receipt", async () => {
    mockFetch(() => json({ ok: true, next: "https://formspree.io/thanks" }));
    const result = await submitFeedback({ message: "please add evening slots" });
    expect(result).toEqual({ ok: true, activationPending: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(FEEDBACK_ENDPOINT);
    expect(calls[0]!.init.method).toBe("POST");
  });

  test("pending recipient verification is a failure, never a success", async () => {
    mockFetch(() =>
      json({
        ok: false,
        errors: [
          { code: "EMAIL_NOT_VERIFIED", message: "Please verify your account email address" },
        ],
      }),
    );
    const result = await submitFeedback({ message: "unverified" });
    expect(result).toEqual({ ok: false, reason: "provider_rejected" });
  });

  test("sends our own site origin, never visitor origin data", async () => {
    mockFetch(() => json({ ok: true }));
    await submitFeedback(
      { message: "hello" },
      new Headers({ origin: "https://attacker.example", referer: "https://attacker.example/x" }),
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Origin"]).toBe("https://almustatil.lovable.app");
    expect(headers["Referer"]).toBe(FEEDBACK_FORM_URL);
    expect(JSON.stringify(calls[0])).not.toContain("attacker.example");
  });

  test("sends only the message and fixed controls, no identifying metadata", async () => {
    mockFetch(() => json({ ok: true }));
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.9",
      "user-agent": "SecretBrowser/1.0",
      cookie: "session=abc",
      referer: "https://example.com/private",
    });
    await submitFeedback({ message: "anonymous text" }, headers);
    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(["_subject", "message"]);
    expect(body["message"]).toBe("anonymous text");
    expect(body["_subject"]).toBe(FEEDBACK_SUBJECT);
    const serialized = JSON.stringify(calls[0]);
    expect(serialized).not.toContain("203.0.113.9");
    expect(serialized).not.toContain("SecretBrowser");
    expect(serialized).not.toContain("session=abc");
    expect(serialized).not.toContain("example.com/private");
  });

  test("rejects empty and whitespace-only messages without calling the provider", async () => {
    mockFetch(() => json({ success: true }));
    expect(await submitFeedback({ message: "" })).toEqual({ ok: false, reason: "empty" });
    expect(await submitFeedback({ message: "   \n\t " })).toEqual({ ok: false, reason: "empty" });
    expect(calls).toHaveLength(0);
  });

  test("rejects oversize messages without calling the provider", async () => {
    mockFetch(() => json({ success: true }));
    const result = await submitFeedback({ message: "a".repeat(FEEDBACK_MAX_LENGTH + 1) });
    expect(result).toEqual({ ok: false, reason: "too_long" });
    expect(calls).toHaveLength(0);
  });

  test("honeypot submissions are treated as spam without calling the provider", async () => {
    mockFetch(() => json({ success: true }));
    expect(await submitFeedback({ message: "hello", trap: "bot" })).toEqual({
      ok: false,
      reason: "spam",
    });
    expect(calls).toHaveLength(0);
  });

  test("strips control characters used for header injection", () => {
    expect(sanitizeMessage("hi\u0000\r\nBcc: attacker@example.com")).toBe(
      "hi\nBcc: attacker@example.com",
    );
  });

  test("success false is a provider rejection, never a fake success", async () => {
    mockFetch(() => json({ success: "false", message: "rejected" }));
    expect(await submitFeedback({ message: "valid message" })).toEqual({
      ok: false,
      reason: "provider_rejected",
    });
    resetFeedbackLimits();
    mockFetch(() => json({ success: false }));
    expect(await submitFeedback({ message: "valid message" })).toEqual({
      ok: false,
      reason: "provider_rejected",
    });
  });

  test("HTTP error statuses are provider rejections", async () => {
    mockFetch(() => json({ success: "true" }, 429));
    expect(await submitFeedback({ message: "valid message" })).toEqual({
      ok: false,
      reason: "provider_rejected",
    });
  });

  test("invalid JSON is reported as a send failure", async () => {
    mockFetch(() => new Response("<html>not json</html>", { status: 200 }));
    expect(await submitFeedback({ message: "valid message" })).toEqual({
      ok: false,
      reason: "send_failed",
    });
  });

  test("timeouts and network errors are reported as send failures", async () => {
    mockFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await submitFeedback({ message: "valid message" })).toEqual({
      ok: false,
      reason: "send_failed",
    });
    resetFeedbackLimits();
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await submitFeedback({ message: "valid message" })).toEqual({
      ok: false,
      reason: "send_failed",
    });
  });

  test("rate limits repeat senders from the same caller", async () => {
    mockFetch(() => json({ success: true }));
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.9" });
    const reasons: (string | "ok")[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await submitFeedback({ message: `msg ${i}` }, headers);
      reasons.push(result.ok ? "ok" : result.reason);
    }
    expect(reasons).toEqual(["ok", "ok", "ok", "rate_limited"]);
    expect(calls).toHaveLength(3);
  });
});
