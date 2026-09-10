# Diagnosis: player statistics are all zero (read-only, nothing changed)

## What the visitor sees now

- The Players Stats page is **not** unavailable and **not** empty of players: it lists **96 players** with correct English/Arabic names and positions, and the position filter works.
- What is empty is the **statistics**. Opening any profile (checked `/players/p056`) shows every value as zero: games played 0, goals 0, assists 0, shots 0, passes 0, pass accuracy 0%, tackles 0, clearances 0, dribbles 0, key passes 0, chances created 0, ratings 0.00, MVP 0 — for June, July, August, September and All. The points balance also shows 0.

So "the statistics page is empty" = players load, numbers do not.

## Where the data disappears

Confirmed by reading the live saved copy of the players feed:

- 96 saved players, saved 14:22 UTC, valid until 14:37 UTC, no failure count, no retry/backoff.
- **0 of 96 players have any monthly statistics at all**, and **0 of 96 have a points value** (all null).
- The refresh did read the master player table and all four monthly tables (page counts recorded for all five tables), so the monthly rows were downloaded successfully.

This rules out the areas you asked about:

1. Saved-copy/refresh state: healthy. No lease held, no cooldown, no rate-limit backoff, daily use 113 of 2100, monthly 266 of 65000.
2. Per-feed refresh slots: active in the live database — all eight slots present and free; Players can claim and refresh normally (it did, twice, in the last hour).
3. Airtable reachability: fine — five tables fetched, all pages valid, no upstream errors in the server log since 14:24.
4. Visibility filtering: not the cause — 96 visible players survived it.
5. Position/month handling: not the cause — positions and groups are correct on every card.
6. Month configuration: all four months are configured and all four monthly tables were read.
7. Client/hydration: not the cause — the server payload itself already contains no numbers.

So the loss happens in **one place only**: matching each monthly statistics row to its player, plus the points field, inside `fetchPlayersFromAirtable` in `src/lib/airtable-players.server.ts`.

## Most likely cause (needs one confirmation read)

That function matches monthly rows to players through fixed Airtable field names:

```text
June      -> "احصائيات اللاعبين"
July      -> "PLAYERS DATABASE"
August    -> "PLAYERS DATABASE 2"
September -> "PLAYERS DATABASE 2"
points    -> "Points Balance"
```

Airtable field names are case- and spelling-sensitive. Earlier inspections of this base recorded the link fields as `احصائيات اللاعب`, `Players DATABASE` and `Players DATABASE 2` (mixed case), which do not match the upper-case names in the code. If the names in the base differ by even one character or letter case, every monthly row is treated as having no owner and is dropped — which is exactly the all-zero pattern observed. The points field being empty for all 96 players points the same way: a renamed or removed field in the master table.

This is **deterministic**, not transient: it will show zeros on every load until the names match. It is unrelated to the refresh-slot and 15-minute-expiry work.

I have not confirmed the current Airtable field names, because that requires a live read of the base. Confirming them is step 1 below.

## Proposed smallest safe fix (awaiting your approval)

1. Read-only inspection of the base: list the actual field names of the master player table and the four monthly statistics tables, and confirm which link field each monthly table uses and what the points field is called. No writes, no load test.
2. Align only those names in `src/lib/airtable-players.server.ts` (the link-field map and the points field), making the lookup tolerant of case and surrounding whitespace so a future rename in Airtable cannot silently blank every statistic again.
3. Add a guard test that fails loudly if a monthly table yields rows but no player matches at all, so this cannot go unnoticed again.

No other file, no database change, no Airtable change, no publishing.

## Alternative cause if names turn out to match

If the field names are correct, then the monthly rows themselves are linking to players that are hidden or to master rows the code does not accept, and step 1's inspection will show that directly; the fix would then be in the same function's owner-resolution logic. Either way, the change stays inside `src/lib/airtable-players.server.ts`.
