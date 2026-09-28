CREATE INDEX "event_receipts_payload_live_idx" ON "event_receipts" USING btree ("delivered_at") WHERE "event_receipts"."payload" IS NOT NULL;
--> statement-breakpoint
-- Payload retention for `event_receipts`: the receipt outlives its body.
--
-- The table is append-only by trigger (migration 0134, issue #1177) and blocks
-- UPDATE of every evidence column including `payload`. That guard is doing its
-- job, and this migration does not weaken it: it permits exactly one new
-- transition, `payload` non-NULL -> NULL, and refuses every other mutation of
-- the column (a NULL being filled back in, or one body replaced by another).
--
-- Why the body and not the row. Everything that later depends on a receipt
-- lives in a small column and is kept forever:
--
--   (provider, provider_delivery_id)  the UNIQUE index that makes redelivery a
--                                     no-op via onConflictDoNothing
--   history_id                        the cursor `loadHighestReceiptHistoryId`
--                                     MAXes for Gmail gap detection
--   delivered_at / processing_status  the processing audit (ADR-0090)
--   payload_hash                      evidence a body was verified
--
-- `payload` is 100 MB of the table's 135 MB at an average 3,770 bytes a row,
-- so the body is the expensive part and the receipt is the load-bearing part,
-- and only the body expires. One reader does want the body, but only while it
-- is inside the window: `gatherIntegrationActivity`
-- (`packages/assistant/src/briefings/gather.ts`) reads `payload` to build the
-- `get_day_shape` briefing tool's deployments line. Past the window it falls
-- back to the generic activity lines and that one collapse is lost, which is a
-- cosmetic loss on a day-shape summary rather than a wrong fact. A question
-- about an old message is still answered from `documents`/`chunks` (which dedup
-- independently on (user_id, source, source_id) and are not pruned) or from the
-- live Gmail API through the integration tools.
--
-- Deliberately NOT a row delete. Deleting rows would forfeit the dedup index
-- and the gap cursor, and a provider redelivering an event older than the
-- window would then be ingested as new — a second triage email, a second
-- reply. Nulling the body makes that impossible rather than merely unlikely,
-- because the unique key survives.
--
-- The age policy is NOT in this trigger. This permits the transition; the
-- window belongs to the reaper that performs it, so the rule lives in one place
-- and can be changed without a migration.
--
-- The partial index above is the reaper's: it makes expiry an index-driven scan
-- whose size tracks the retention window rather than the age of the table, since
-- a receipt leaves the index as soon as its body is released.
CREATE OR REPLACE FUNCTION event_receipts_guard_evidence() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'event_receipts is append-only: DELETE rejected (issue #1177)';
  END IF;

  -- The one permitted UPDATE: dropping an expired body. Forward-only in the
  -- sense that a body can be released but never written or replaced, so the
  -- guard still refuses a correction that would rewrite what was delivered.
  IF OLD.payload IS DISTINCT FROM NEW.payload THEN
    IF NOT (OLD.payload IS NOT NULL AND NEW.payload IS NULL) THEN
      RAISE EXCEPTION 'event_receipts payload is write-once: only expiry to NULL is permitted (issue #1177)';
    END IF;
  END IF;

  -- Lifecycle columns the delivery job owns (`markProcessed` in
  -- `inbound-deliver.ts`): processing_status / processed_at / updated_at.
  -- Every other column is evidence or identity and must not change.
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.provider_delivery_id IS DISTINCT FROM NEW.provider_delivery_id
    OR OLD.credential_id IS DISTINCT FROM NEW.credential_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.event_type IS DISTINCT FROM NEW.event_type
    OR OLD.raw_kind IS DISTINCT FROM NEW.raw_kind
    OR OLD.history_id IS DISTINCT FROM NEW.history_id
    OR OLD.verification_result IS DISTINCT FROM NEW.verification_result
    OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
    OR OLD.delivered_at IS DISTINCT FROM NEW.delivered_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'event_receipts evidence is immutable: only processing_status/processed_at/updated_at may change (issue #1177)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
