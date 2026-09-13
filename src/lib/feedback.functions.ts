import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

export interface FeedbackInput {
  message: string;
  trap?: string;
}

export type FeedbackReason =
  | "empty"
  | "too_long"
  | "rate_limited"
  | "spam"
  | "provider_rejected"
  | "send_failed";

export type FeedbackResponse =
  | { ok: true; activationPending: boolean }
  | { ok: false; reason: FeedbackReason };

/** Anonymous suggestion / complaint submission. Recipient is fixed server-side. */
export const sendFeedback = createServerFn({ method: "POST" })
  .inputValidator((input: FeedbackInput) => ({
    message: typeof input?.message === "string" ? input.message : "",
    trap: typeof input?.trap === "string" ? input.trap : "",
  }))
  .handler(async ({ data }): Promise<FeedbackResponse> => {
    const { submitFeedback } = await import("./feedback.server");
    let headers: Headers | undefined;
    try {
      headers = getRequestHeaders() as unknown as Headers;
    } catch {
      headers = undefined;
    }
    return submitFeedback(data, headers);
  });
