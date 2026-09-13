import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFeedbackLimits, sendFeedbackEmail } from "../src/lib/feedback.server";

const CANARY = "شكوى سرية من لاعب canary-secret-12345";
const PROVIDER_TEXT = "Make sure you open this page through a web server, CORS requests are blocked";

let logs: unknown[] = [];

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
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(...args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("feedback failure diagnostics", () => {
  it("maps the provider's web-server notice to origin_required", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { success: "false", message: PROVIDER_TEXT })));
    const result = await sendFeedbackEmail(CANARY);
    expect(result).toEqual({ ok: false, reason: "provider_rejected" });
    expect(logs).toHaveLength(1);
    const line = logs[0] as Record<string, unknown>;
    expect(line["event"]).toBe("feedback_submit_failure");
    expect(line["category"]).toBe("provider-rejected");
    expect(line["code"]).toBe("origin_required");
    expect(line["status"]).toBe(200);
    expect(line["contentClass"]).toBe("json");
    expect(typeof line["elapsedMs"]).toBe("number");
    expect(typeof line["at"]).toBe("string");
    expect(typeof line["ref"]).toBe("string");
  });

  it("never leaks the message, recipient or upstream text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { success: "false", message: PROVIDER_TEXT })));
    await sendFeedbackEmail(CANARY);
    const dump = serialized();
    expect(dump).not.toContain("canary-secret-12345");
    expect(dump).not.toContain("شكوى");
    expect(dump).not.toContain("almustatilalakhdar");
    expect(dump).not.toContain("formsubmit");
    expect(dump).not.toContain("web server");
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

  it("classifies an HTTP 403 HTML challenge as blocked_or_challenge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html><title>Attention Required! | Cloudflare</title></html>", {
            status: 403,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ),
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

  it("classifies rate limiting, captcha, activation and invalid requests", async () => {
    const cases: Array<[Response, string, string]> = [
      [new Response("Too many requests", { status: 429 }), "rate_limited", "upstream-http"],
      [jsonResponse(200, { success: "false", message: "Captcha verification failed" }), "captcha_required", "provider-rejected"],
      [
        jsonResponse(200, { success: "false", message: "This form needs Activation. We've sent you an email" }),
        "activation_required",
        "provider-rejected",
      ],
      [new Response("Bad request", { status: 400 }), "invalid_request", "upstream-http"],
      [new Response("nope", { status: 500 }), "provider_rejected_unknown", "upstream-http"],
    ];
    for (const [response, code, category] of cases) {
      logs = [];
      vi.stubGlobal("fetch", vi.fn(async () => response));
      await sendFeedbackEmail("hello");
      const line = logs[0] as Record<string, unknown>;
      // The activation notice is an accepted receipt, so no failure line is logged.
      if (code === "activation_required") {
        expect(logs).toHaveLength(0);
        continue;
      }
      expect(line["code"]).toBe(code);
      expect(line["category"]).toBe(category);
    }
  });

  it("logs invalid_json for an unparsable success response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } })),
    );
    const result = await sendFeedbackEmail("hello");
    expect(result).toEqual({ ok: false, reason: "send_failed" });
    const line = logs[0] as Record<string, unknown>;
    expect(line["category"]).toBe("invalid-response");
    expect(line["code"]).toBe("invalid_json");
  });

  it("logs fixed codes for timeouts and network errors", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeout; }));
    await sendFeedbackEmail("hello");
    expect((logs[0] as Record<string, unknown>)["code"]).toBe("timeout");
    expect((logs[0] as Record<string, unknown>)["category"]).toBe("timeout");
    expect(serialized()).not.toContain("aborted");

    logs = [];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed to secret.host"); }));
    await sendFeedbackEmail("hello");
    expect((logs[0] as Record<string, unknown>)["code"]).toBe("network");
    expect((logs[0] as Record<string, unknown>)["category"]).toBe("network");
    expect(serialized()).not.toContain("secret.host");
  });

  it("logs nothing on a successful submission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { success: "true", message: "ok" })));
    const result = await sendFeedbackEmail(CANARY);
    expect(result).toEqual({ ok: true, activationPending: false });
    expect(logs).toHaveLength(0);
  });
});
