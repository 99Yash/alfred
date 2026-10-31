-- Sentry connects only through its MCP server now. Its credential rows (and their receipts, by
-- cascade), its receipt documents and its issue objects have no reader or producer.
DELETE FROM "integration_credentials" WHERE "provider" = 'sentry';--> statement-breakpoint
DELETE FROM "documents" WHERE "source" = 'sentry';--> statement-breakpoint
DELETE FROM "integration_objects" WHERE "provider" = 'sentry';--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_source_valid";--> statement-breakpoint
ALTER TABLE "integration_credentials" DROP CONSTRAINT "integration_credentials_provider_valid";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_valid" CHECK ("documents"."source" IN ('github', 'gmail', 'gmail_attachment'));--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_provider_valid" CHECK ("integration_credentials"."provider" IN ('github', 'google', 'vercel'));
