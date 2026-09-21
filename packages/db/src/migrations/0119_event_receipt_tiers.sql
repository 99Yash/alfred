ALTER TABLE "event_receipts" ADD CONSTRAINT "event_receipts_raw_type_check" CHECK (("event_receipts"."raw_kind" IS NULL) = ("event_receipts"."event_type" NOT LIKE '%.raw'));--> statement-breakpoint
ALTER TABLE "event_receipts" ADD CONSTRAINT "event_receipts_raw_completed_check" CHECK ("event_receipts"."raw_kind" IS NULL OR ("event_receipts"."processing_status" = 'completed' AND "event_receipts"."processed_at" IS NOT NULL));--> statement-breakpoint
CREATE VIEW "public"."typed_event_receipts" AS (select "id", "provider", "provider_delivery_id", "credential_id", "user_id", "event_type", "history_id", "verification_result", "payload_hash", "payload", "processing_status", "delivered_at", "processed_at", "created_at", "updated_at" from "event_receipts" where "event_receipts"."raw_kind" is null);
--> statement-breakpoint
-- Keep exact retries of existing raw rows on the new kind-scoped key.
UPDATE "event_receipts"
SET "provider_delivery_id" = 'raw:' || "raw_kind" || ':' || "payload_hash"
WHERE "raw_kind" IS NOT NULL AND "provider_delivery_id" = "payload_hash";
