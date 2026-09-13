import { describe, expect, test } from "bun:test";

/**
 * Regression: the serverless runtime forbids randomness at module scope
 * ("Disallowed operation called within global scope"). The salt must be
 * created lazily on the first request and stay stable per isolate afterwards.
 */
describe("feedback salt lazy initialization", () => {
  test("import performs no randomness; salt created on first request and stable", async () => {
    // Fresh module instance (query busts the import cache).
    const mod = await import(`../src/lib/feedback.server?lazy=${Date.now()}`);

    // Importing the module must not have created the salt.
    expect(mod.hasActiveSalt()).toBe(false);

    const headers = new Headers({ "x-forwarded-for": "203.0.113.7" });

    // First request-handling call initializes the salt lazily.
    expect(mod.allowFeedback(headers)).toBe(true);
    expect(mod.hasActiveSalt()).toBe(true);

    // Subsequent requests reuse the same salt: the same caller is grouped into
    // one bucket, so the 4th send inside the window is rate-limited. A fresh
    // random salt per call would never group and this would pass instead.
    expect(mod.allowFeedback(headers)).toBe(true);
    expect(mod.allowFeedback(headers)).toBe(true);
    expect(mod.allowFeedback(headers)).toBe(false);
  });
});
