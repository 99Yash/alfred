-- Remove the disposable row created by the historical embedding smoke before
-- the source vocabulary became closed. Its chunks cascade with the document.
DELETE FROM "documents"
WHERE "source" = 'smoke' AND "source_id" = 'm7b-quarterly-update';--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_valid" CHECK ("documents"."source" IN ('gmail', 'gcal', 'slack', 'linear', 'github', 'notion', 'imessage'));
