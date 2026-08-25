-- #374 follow-up: every row must have a redacted display projection.
-- 0106 added `display_input` as nullable so existing rows keep their
-- `proposed_input`. This backfills those legacy rows so the
-- `COALESCE(display_input, proposed_input)` fallback in the notification
-- worker can be retired. The only writer of redacted secrets is
-- `autonomous-only` (fetch_url) today, so no pre-migration pending row
-- can carry a redactable secret — backfilling from `proposed_input` is
-- safe. Idempotent: only touches rows still NULL.
UPDATE "action_stagings" SET "display_input" = "proposed_input" WHERE "display_input" IS NULL;
