ALTER TABLE "agent_runs" ADD COLUMN "trigger" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "last_scheduled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workflows_next_run_at_idx" ON "workflows" USING btree ("next_run_at") WHERE "workflows"."status" = 'active' AND "workflows"."trigger"->>'kind' = 'cron';