import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_RECIPIENT,
  resetFeedbackLimits,
  sanitizeMessage,
  submitFeedback,
} from "../src/lib/feedback.server";

const originalDomain = process.env["EMAIL_SENDER_DOMAIN"];
const originalKey = process.env["LOVABLE_API_KEY"];

beforeEach(() => {
  resetFeedbackLimits();
});

afterEach(() => {
  if (originalDomain === undefined) delete process.env["EMAIL_SENDER_DOMAIN"];
  else process.env["EMAIL_SENDER_DOMAIN"] = originalDomain;
  if (originalKey === undefined) delete process.env["LOVABLE_API_KEY"];
  else process.env["LOVABLE_API_KEY"] = originalKey;
});

describe("anonymous feedback", () => {
  test("recipient is fixed server-side", () => {
    expect(FEEDBACK_RECIPIENT).toBe("almustatilalakhdar@gmail.com");
  });

  test("rejects empty and whitespace-only messages", async () => {
    expect(await submitFeedback({ message: "" })).toEqual({ ok: false, reason: "empty" });
    expect(await submitFeedback({ message: "   \n\t " })).toEqual({ ok: false, reason: "empty" });
  });

  test("rejects oversize messages", async () => {
    const result = await submitFeedback({ message: "a".repeat(FEEDBACK_MAX_LENGTH + 1) });
    expect(result).toEqual({ ok: false, reason: "too_long" });
  });

  test("honeypot submissions are treated as spam", async () => {
    expect(await submitFeedback({ message: "hello", trap: "bot" })).toEqual({
      ok: false,
      reason: "spam",
    });
  });

  test("strips control characters used for header injection", () => {
    expect(sanitizeMessage("hi\u0000\r\nBcc: attacker@example.com")).toBe(
      "hi\nBcc: attacker@example.com",
    );
  });

  test("reports missing email configuration instead of faking success", async () => {
    delete process.env["EMAIL_SENDER_DOMAIN"];
    process.env["LOVABLE_API_KEY"] = "test-key";
    const result = await submitFeedback({ message: "valid message" });
    expect(result).toEqual({ ok: false, reason: "email_not_configured" });
  });

  test("rate limits repeat senders from the same caller", async () => {
    delete process.env["EMAIL_SENDER_DOMAIN"];
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.9" });
    const reasons: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await submitFeedback({ message: `msg ${i}` }, headers);
      if (!result.ok) reasons.push(result.reason);
    }
    expect(reasons.slice(0, 3)).toEqual([
      "email_not_configured",
      "email_not_configured",
      "email_not_configured",
    ]);
    expect(reasons[3]).toBe("rate_limited");
  });

  test("send failures are reported generically", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    process.env["EMAIL_SENDER_DOMAIN"] = "notify.invalid.test";
    const result = await submitFeedback({ message: "valid message" });
    expect(result).toEqual({ ok: false, reason: "send_failed" });
  });
});
