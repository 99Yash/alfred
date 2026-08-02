DROP INDEX IF EXISTS "agent_runs_event_active_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "agent_runs_chat_thread_active_idx";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "occurrence_key" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "replay_of_run_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "deferred_until" timestamp with time zone;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_replay_of_run_id_agent_runs_id_fk' AND conrelid = 'agent_runs'::regclass) THEN
		ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_replay_of_run_id_agent_runs_id_fk" FOREIGN KEY ("replay_of_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runs_occurrence_idx" ON "agent_runs" USING btree ("user_id","occurrence_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_event_active_idx" ON "agent_runs" USING btree ("user_id","workflow_slug",coalesce("trigger" ->> 'source', ''),coalesce("trigger" ->> 'type', ''),("trigger" ->> 'eventId'),coalesce("trigger" -> 'payload' ->> 'reason', '')) WHERE ("agent_runs"."trigger" ->> 'kind') = 'event' AND ("agent_runs"."trigger" ->> 'eventId') IS NOT NULL AND "agent_runs"."status" NOT IN ('completed', 'failed', 'cancelled', 'blocked');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_chat_thread_active_idx" ON "agent_runs" USING btree ("user_id",("metadata" ->> 'threadId')) WHERE "agent_runs"."workflow_slug" = '__chat-turn__' AND ("agent_runs"."metadata" ->> 'threadId') IS NOT NULL AND "agent_runs"."status" NOT IN ('completed', 'failed', 'cancelled', 'blocked');
