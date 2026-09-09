/**
 * M1: single public error representation.
 *
 * Anything that crosses the server -> visitor boundary (server function throw,
 * route errorComponent, browser reporting hook) uses this shape. It carries no
 * upstream message, status text, URL, body, cause, stack or custom property.
 */

/** Stable generic message shown to visitors when a feed cannot be loaded. */
export const PUBLIC_ERROR_MESSAGE = "This content is temporarily unavailable.";

/** Marker name so boundaries can recognise an already-sanitized error. */
export const PUBLIC_ERROR_NAME = "PublicError";

/**
 * Builds a fresh Error whose complete serialized surface is safe: fixed name,
 * fixed message, empty stack, no cause and no own enumerable properties.
 */
export function createPublicError(): Error {
  const error = new Error(PUBLIC_ERROR_MESSAGE);
  // Non-enumerable so the error has no own enumerable properties at all.
  Object.defineProperty(error, "name", {
    value: PUBLIC_ERROR_NAME,
    enumerable: false,
    writable: true,
    configurable: true,
  });

  // Stack strings can embed file paths and framework internals; drop it.
  Object.defineProperty(error, "stack", {
    value: "",
    enumerable: false,
    writable: true,
    configurable: true,
  });
  // Some runtimes attach sourceURL/line/column outside the stack string.
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key !== "message" && key !== "name" && key !== "stack") Reflect.deleteProperty(error, key);
  }
  return error;
}

export function isPublicError(error: unknown): boolean {
  return error instanceof Error && error.name === PUBLIC_ERROR_NAME;
}
