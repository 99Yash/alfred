SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX "agent_runs_active_event_idx" ON "agent_runs" USING btree ("user_id","workflow_slug") WHERE "agent_runs"."status" NOT IN ('completed', 'failed', 'cancelled');
