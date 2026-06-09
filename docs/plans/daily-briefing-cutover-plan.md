# Daily-briefing cutover plan

**Status:** planned (not started). Briefing cron dispatch is **paused** in the
meantime — see `BRIEFING_DISPATCH_PAUSED` in
`packages/api/src/modules/briefing/queue.ts`.

**Goal:** make the hourly briefing cron dispatch the LLM-composed
`daily-briefing` workflow as the live, canonical path for both the morning
briefing and evening recap — replacing the old `morning-briefing` workflow —
without regressing the in-app briefing surface.

## Why this is a plan, not a one-line swap

The naming is inverted from how the code actually works. As of 2026-06-09:

| | `morning-briefing` (currently live) | `daily-briefing` (the target) |
|---|---|---|
| Compose | boss-model, structured multi-source gather (ADR-0041) | LLM-composed prose, watermarked delta, reads prior briefings as memory (ADR-0048) |
| Slots | morning + evening | morning + evening |
| Canonical table | **`briefings`** via the full state machine in `briefing/store.ts` (`beginBriefing` → `markBriefingComposing` → `markBriefingComposed` → `markBriefingSent` / `markBriefingSuppressed` / `markBriefingFailed`) | **`briefing_runs`** (legacy) via `recordBriefingRun` in `briefing/read.ts` |
| Morning suppression (ADR-0048 discretionary morning) | yes (`markBriefingSuppressed`) | **no** — `send` step always sends |
| In-app surface integration | yes (reads `briefings`) | no |
| Smoke-validated against samples | n/a (live) | **never validated** — its own description says "Replaces m10 morning-briefing once smoke validates" |

So swapping `enqueueBriefingRun` to `DAILY_BRIEFING_WORKFLOW_SLUG` would send
LLM emails but write the legacy table, skip suppression, and orphan the in-app
surface. The cutover has to reconcile those first.

## Decisions to settle first

1. **Canonical table.** Either (a) migrate `daily-briefing` onto the
   `briefings` state machine (`store.ts`) and retire `briefing_runs`, or (b)
   declare `briefing_runs` canonical and re-point the in-app surface + watermark
   reads at it. (a) is preferred — it keeps ADR-0048's open-loop surface intact.
   Likely warrants an ADR amendment if we change which table is canonical.
2. **Morning suppression.** Port ADR-0048's discretionary-morning /
   always-evening logic into `daily-briefing` (it currently always sends).
3. **Watermark continuity.** `fetchLatestWatermark` reads `briefings`. If
   `daily-briefing` starts writing `briefings`, confirm the watermark anchor is
   written at the same step the old path used, so the delta window doesn't skip
   or double-count.

## Work (sketch — refine when picked up)

1. **Reconcile the table.** Migrate `daily-briefing`'s `persist` step from
   `recordBriefingRun` to the `briefings` state machine (`beginBriefing` at
   `gather`, `markBriefing*` through the lifecycle). Keep `briefing_runs` only
   if something still reads it; otherwise schedule its removal.
2. **Add suppression.** Implement morning quiet-day suppression
   (`markBriefingSuppressed`) per ADR-0048; evening always sends.
3. **Dry-run validation.** Run `daily-briefing` with `dryRun: true` for several
   days against real inbox/calendar data; compare output quality + section
   coverage against the old briefings and the Dimension samples.
4. **Flip dispatch.** Point `enqueueBriefingRun` at
   `DAILY_BRIEFING_WORKFLOW_SLUG` and set `BRIEFING_DISPATCH_PAUSED = false`.
5. **Verify end-to-end.** Trigger a manual run on prod (`briefing.run`), confirm
   a real `email_sends` row + a canonical `briefings` row + in-app surface
   render.
6. **Retire `morning-briefing`.** Once daily-briefing is the live path and
   validated, deregister `morning-briefing` from the builtins registry.

## Related

- ADR-0048 (open-loop briefing unit, discretionary morning / always-on evening),
  ADR-0049 (in-app briefing surface).
- `docs/reference/briefing.md`.
- The timezone-default bug that masked all of this is fixed separately in
  `packages/contracts/src/briefing.ts` (`isSupportedTimezone`).
- Settings now has a delivery time + timezone picker
  (`apps/web/src/routes/-preview-settings/briefing-schedule-section.tsx`) writing
  the `briefing.timezone` / `briefing.delivery_hour` / `briefing.evening_hour`
  prefs the cron reads.
