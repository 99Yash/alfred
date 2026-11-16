-- One copy of each webhook body (docs/theory/stores.md, step 3). The body is in the
-- receipt's corpus document (`documents.raw`), written in the receipt's transaction.
-- PR #1763 stopped writing `payload`, and on 2026-11-15 the production report of
-- `backfill-receipt-documents-committed.ts` showed 0 receipt bodies without a document.
-- So this drops the column, the partial index of the retention reaper, and the guard's
-- payload clause. The view selects the column, so it is dropped and made again.
--
-- The guard function must change in this migration: a plpgsql body that names
-- `OLD.payload` fails at run time once the column is gone, and every UPDATE of a
-- receipt (`markProcessed`) runs it. This is the 0170 function without that clause.
DROP VIEW "public"."typed_event_receipts";--> statement-breakpoint
DROP INDEX "event_receipts_payload_live_idx";--> statement-breakpoint
ALTER TABLE "event_receipts" DROP COLUMN "payload";--> statement-breakpoint
CREATE VIEW "public"."typed_event_receipts" AS (select "id", "provider", "provider_delivery_id", "credential_id", "user_id", "event_type", "history_id", "verification_result", "payload_hash", "processing_status", "delivered_at", "processed_at", "created_at", "updated_at" from "event_receipts" where "event_receipts"."raw_kind" is null);--> statement-breakpoint
CREATE OR REPLACE FUNCTION event_receipts_guard_evidence() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'event_receipts is append-only: DELETE rejected (issue #1177)';
  END IF;

  -- A credential delete detaches its receipts. Only the nested FK action may do it,
  -- and only to NULL.
  IF OLD.credential_id IS DISTINCT FROM NEW.credential_id THEN
    IF NOT (OLD.credential_id IS NOT NULL AND NEW.credential_id IS NULL AND pg_trigger_depth() > 1) THEN
      RAISE EXCEPTION 'event_receipts credential_id is immutable: only the credential delete may set it to NULL';
    END IF;
  END IF;

  -- Lifecycle columns the delivery job owns (`markProcessed` in
  -- `inbound-deliver.ts`): processing_status / processed_at / updated_at.
  -- Every other column is evidence or identity and must not change.
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.provider_delivery_id IS DISTINCT FROM NEW.provider_delivery_id
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
