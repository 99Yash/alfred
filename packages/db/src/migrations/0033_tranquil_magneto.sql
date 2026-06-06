ALTER TABLE "email_triage" ADD COLUMN "source" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_triage" ADD COLUMN "overridden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_triage" ADD COLUMN "row_version" integer DEFAULT 0 NOT NULL;