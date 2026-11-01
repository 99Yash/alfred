-- ADR-0118 decision 8: a GitHub `workflow_job` receipt gets no embedding. The receipt writer marks
-- new rows (`receiptKindEmbeds` in `@alfred/assistant`'s `receipt-corpus-policy.ts`). This marks the
-- rows written before it with the same reason, `RECEIPT_KIND_NOT_EMBEDDED_REASON`, and deletes their
-- chunks. A row that the daily cap skipped moves to the new reason, so the integration page counts
-- only real cap skips. The receipts and the documents stay. A second run changes nothing.
UPDATE "documents"
SET "embed_failed_at" = COALESCE("embed_failed_at", now()),
    "last_embed_error" = 'receipt_kind_not_embedded'
WHERE "source" = 'github'
  AND split_part("metadata"->>'kind', '.', 1) = 'workflow_job'
  AND "last_embed_error" IS DISTINCT FROM 'receipt_kind_not_embedded';--> statement-breakpoint
DELETE FROM "chunks"
WHERE "document_id" IN (
  SELECT "id" FROM "documents"
  WHERE "source" = 'github'
    AND split_part("metadata"->>'kind', '.', 1) = 'workflow_job'
);
