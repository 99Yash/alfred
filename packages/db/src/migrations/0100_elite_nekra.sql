ALTER TABLE "action_stagings" ADD COLUMN "outcome" text DEFAULT 'planned' NOT NULL;--> statement-breakpoint
ALTER TABLE "action_stagings" ADD COLUMN "effect_key" text;--> statement-breakpoint
ALTER TABLE "action_stagings" ADD COLUMN "attempt_key" text;--> statement-breakpoint
ALTER TABLE "action_stagings" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "action_stagings" ADD COLUMN "provider_key" text;--> statement-breakpoint
ALTER TABLE "action_stagings" ADD COLUMN "provider_ref" text;--> statement-breakpoint
-- #559a backfill. The new identity columns are NOT NULL with no default, so
-- existing rows (the live approvals/executions ledger) must get values before
-- the NOT NULL constraints can be applied. Every legacy row is a SINGLE attempt
-- of one logical effect: derive `effect_key` and `attempt_key` from the row id
-- (stable, unique) and reuse the already-stable `proposed_input_hash` as the
-- request basis. These rows are terminal or in-flight, never `unknown`, so the
-- partial barrier index below never keys on them.
UPDATE "action_stagings" SET
  "effect_key" = 'legacy:' || "id",
  "attempt_key" = 'legacy:' || "id" || ':1',
  "request_hash" = 'legacy:' || "proposed_input_hash",
  "outcome" = CASE
    WHEN "status" = 'executed' THEN 'succeeded'
    WHEN "status" = 'failed' THEN 'failed'
    WHEN "status" = 'pending' AND "requires_approval" THEN 'awaiting_approval'
    WHEN "status" = 'approved' THEN 'dispatching'
    ELSE 'planned'
  END;--> statement-breakpoint
ALTER TABLE "action_stagings" ALTER COLUMN "effect_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "action_stagings" ALTER COLUMN "attempt_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "action_stagings" ALTER COLUMN "request_hash" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "action_stagings_unknown_effect_idx" ON "action_stagings" USING btree ("user_id","request_hash") WHERE "action_stagings"."outcome" = 'unknown';
