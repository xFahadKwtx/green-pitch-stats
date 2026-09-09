import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { withPublicRequestBoundary } from "./lib/public-error.server";

const errorMiddleware = createMiddleware().server(({ next }) => withPublicRequestBoundary(next));

// Start installs this automatically when src/start.ts is absent; defining the
// file opts out, so re-add it explicitly to keep server functions protected
// from cross-site requests.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware, csrfMiddleware],
}));
