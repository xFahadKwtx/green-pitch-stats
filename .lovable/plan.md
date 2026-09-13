# Contact form failure on the live site — diagnosis

## What the visitor sees

On https://almustatil.lovable.app/contact the message box shows
"تعذّر إرسال الرسالة حالياً. الرجاء المحاولة لاحقاً." That wording is the single
generic failure text used for three different internal outcomes, so the message
itself does not tell us which one happened.

## Confirmed by evidence

1. The server side runs and does not crash. Live logs show the contact
   submissions at 22:17 UTC (five attempts) each answered with HTTP 200, and no
   error line anywhere in the last hour of live logs. So this is not a startup
   crash, not a missing import, not a random-number/global-scope failure, and not
   a request-encoding problem: our code executed and returned a normal
   "could not send" answer.
2. It is not the "empty message", "too long", or "too many messages" path — each
   of those shows different wording on the page.
3. So the failure happens at the step where our server hands the message to
   FormSubmit: either FormSubmit answered with a refusal, or the call did not
   complete (blocked, non-JSON answer, or timeout).
4. The exact reason is deliberately discarded. The sending code catches every
   upstream problem and returns a bare generic reason, and unlike the rest of the
   site this path writes no sanitized diagnostic line. That is why the live logs
   are silent, and why the cause cannot be narrowed further from logs alone.

## Inferred (not yet proven)

The most likely cause is that FormSubmit is refusing or blocking the call as it
arrives from the live site's own servers. Important detail from history: the
earlier successful submissions (the activation probe and the labelled Arabic test
message) were sent from the build sandbox, not from the live site. The live site
has never had a confirmed successful call to FormSubmit. Common refusals in this
situation are a bot/abuse block returning an HTML page instead of JSON, or a
refusal tied to the site-identity headers we attach with the request.

I will not test this by sending a real message, since the only authorization given
was for activation. An intentionally empty or honeypot payload is rejected by our
own validation before the call is made, so it cannot prove anything about
FormSubmit either.

## Smallest safe fix (proposed)

Make the cause visible, then fix the cause — in that order.

Step 1 (this change): add one bounded, sanitized diagnostic line to the feedback
path, reusing the site's existing safe reporting helper. It records only: the
event name, a category (refused / blocked / invalid answer / timeout), the HTTP
status number, whether the answer was valid JSON, a timestamp and a random
reference. It never records the message text, the recipient address, headers,
visitor address or any provider text. Visitor-facing wording, design, Arabic
text, the single message box, validation, spam protection and rate limits stay
exactly as they are.

Step 2 (after we can see the cause): apply the minimal correction the diagnostic
points to — most likely adjusting how the request identifies our site, or
switching the request body format, or moving delivery to a provider that accepts
server-to-server calls. That step will come back to you as its own small plan.

## What needs your authorization

- Publishing step 1, so the diagnostic can record what happens live.
- Exactly one real submission on the live contact page after publishing (any
  short text) so a real attempt is captured. Without one real attempt the cause
  stays invisible. Nothing is emailed beyond that single message, and I will not
  read message contents.

## Technical notes

- Files that would change in step 1: `src/lib/feedback.server.ts` (add
  sanitized failure logging around the upstream call and the response checks),
  `src/lib/server-diagnostics.server.ts` (add a feedback event to the existing
  allowlisted logger), plus focused tests in `tests/feedback.test.ts`
  asserting the log line carries only allowlisted fields and no message text.
- Evidence reviewed read-only: `src/lib/feedback.server.ts`,
  `src/lib/feedback.functions.ts`, `src/components/anonymous-feedback.tsx`,
  `src/lib/i18n.tsx`, `src/lib/server-diagnostics.server.ts`, and the live
  worker request logs for the last hour. No files, settings, secrets or
  dependencies were touched, and no message was submitted.
