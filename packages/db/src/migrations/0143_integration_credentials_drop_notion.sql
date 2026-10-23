-- Notion connects only through its MCP server now (#1008). Its bearer rows have no reader.
DELETE FROM "integration_credentials" WHERE "provider" = 'notion';--> statement-breakpoint
ALTER TABLE "integration_credentials" DROP CONSTRAINT "integration_credentials_provider_valid";--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_provider_valid" CHECK ("integration_credentials"."provider" IN ('github', 'google', 'sentry', 'vercel'));