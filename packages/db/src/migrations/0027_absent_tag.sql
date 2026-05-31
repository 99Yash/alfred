SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "user_action_policies" ADD COLUMN "row_version" integer DEFAULT 1 NOT NULL;
