import { describeDiagnostic } from "./server-diagnostics.server";

// Preserve the existing out-of-band capture lifecycle; sanitize only log output.

let lastCapturedError: { error: unknown; at: number } | undefined;
const TTL_MS = 5_000;

function record(error: unknown) {
  lastCapturedError = { error, at: Date.now() };
}

export function describeError(error: unknown): string {
  return describeDiagnostic(error);
}

function isErrorLike(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

// Wrap console.error so errors logged by any layer — including h3's internal
// unhandled-error logging, which this file cannot hook directly — are both
// recorded for consumeLastCapturedError and sanitized before serialization.
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  for (const arg of args) {
    if (isErrorLike(arg)) record(arg);
  }
  try {
    originalConsoleError(...args.slice(0, 4).map(describeError));
  } catch {
    // Logging must not turn a handled failure into another public error.
  }
};

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("error", (event) => record((event as ErrorEvent).error ?? event));
  globalThis.addEventListener("unhandledrejection", (event) =>
    record((event as PromiseRejectionEvent).reason),
  );
}

export function consumeLastCapturedError(): unknown {
  if (!lastCapturedError) return undefined;
  if (Date.now() - lastCapturedError.at > TTL_MS) {
    lastCapturedError = undefined;
    return undefined;
  }
  const { error } = lastCapturedError;
  lastCapturedError = undefined;
  return error;
}
