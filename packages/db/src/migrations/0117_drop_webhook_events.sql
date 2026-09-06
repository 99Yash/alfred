-- #975 / ADR-0097 item 8: event_receipts is the one delivery record. Before the
-- ingress route stored receipts (2026-09-05), GitHub deliveries reached only
-- webhook_events. Copy the rows that are attributable to one credential (the
-- GitHub App installation the delivery named, owned by the same user) so the
-- audit trail keeps them; rows nobody owns go with the table (ADR-0097 alt e).
-- Only the event types the github entry declares are copied, so every copied
-- event_type decodes with parseEventTypeName. The rows were already folded
-- inline when they arrived, so they land as 'completed'.
INSERT INTO "event_receipts" (
  "id", "provider", "provider_delivery_id", "credential_id", "user_id", "event_type",
  "verification_result", "payload", "processing_status", "delivered_at", "processed_at",
  "created_at", "updated_at"
)
SELECT DISTINCT ON (w."provider", w."provider_event_id")
  'evr_' || substr(md5(w."id"), 1, 12),
  w."provider",
  w."provider_event_id",
  c."id",
  w."user_id",
  w."provider" || '.' || w."event_type",
  'signature_valid',
  w."payload",
  'completed',
  w."delivered_at",
  w."created_at",
  w."created_at",
  w."updated_at"
FROM "webhook_events" w
JOIN "integration_credentials" c
  ON c."provider" = w."provider"
 AND c."installation_id" = w."installation_id"
 AND c."user_id" = w."user_id"
WHERE w."provider" = 'github'
  AND w."event_type" IN ('pull_request', 'push', 'issues', 'pull_request_review')
ORDER BY w."provider", w."provider_event_id", (c."status" = 'active') DESC, c."updated_at" DESC
ON CONFLICT ("provider", "provider_delivery_id") DO NOTHING;--> statement-breakpoint
DROP TABLE "webhook_events" CASCADE;
