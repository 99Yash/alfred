DELETE FROM "integration_credentials" WHERE "provider" = 'railway';--> statement-breakpoint
ALTER TABLE "integration_credentials" DROP CONSTRAINT "integration_credentials_provider_valid";--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_provider_valid" CHECK ("integration_credentials"."provider" IN ('github', 'google', 'notion', 'sentry', 'vercel'));
