# Fix Store’s temporary availability failure

## What will change
- Restore the last-known non-empty cached response when a feed refresh is temporarily blocked or unavailable.
- Keep fresh-cache validation strict; stale data is used only as a fallback after the coordinator cannot refresh.
- Preserve fail-closed behavior when no non-empty saved response exists.
- Preserve the Players-only protection against replacing existing player data with an empty refresh.

## Verification
- Update focused cache tests for Store’s exact expired-cache/global-lease scenario and cold-cache failure.
- Run the H2 and M1 suites, installed TypeScript check, and verify the Store page loads without a blank error state.

## Technical scope
- Limit production changes to `src/lib/public-feed-cache.server.ts`.
- Update only `tests/h2-cache.test.ts` for regression coverage.
- No Airtable writes, database changes, migrations, request-limit changes, UI changes, deployment, or publishing.
