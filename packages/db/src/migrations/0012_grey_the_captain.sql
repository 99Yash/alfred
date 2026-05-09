ALTER TABLE "skill_revisions" ADD COLUMN "row_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "row_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "row_version" integer DEFAULT 0 NOT NULL;