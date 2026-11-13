-- A Disconnect keeps the stored receipts (owner decision 2026-11-13). Before this
-- migration, `event_receipts.credential_id` cascaded, so a credential delete erased
-- every receipt of that account (ADR-0118 residual risk). Now the column is nullable
-- and the FK sets it to NULL. `ingestion_state.credential_id` still cascades: it is
-- the sync cursor of that one credential. `user_id` still cascades.
ALTER TABLE "event_receipts" DROP CONSTRAINT "event_receipts_credential_id_integration_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "event_receipts" ALTER COLUMN "credential_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "event_receipts" ADD CONSTRAINT "event_receipts_credential_id_integration_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."integration_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The guard from migrations 0134 and 0139, with one more permitted UPDATE: the FK
-- action sets `credential_id` to NULL. That action is an UPDATE that runs nested in
-- the RI trigger of the credential delete, at pg_trigger_depth() > 1. A direct UPDATE
-- runs at depth 1, so application code still cannot detach or move a receipt.
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
