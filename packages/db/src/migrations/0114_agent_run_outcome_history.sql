ALTER TABLE "agent_runs" ADD COLUMN "outcome" jsonb;--> statement-breakpoint
CREATE INDEX "agent_runs_workflow_history_idx" ON "agent_runs" USING btree ("user_id","workflow_slug","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "email_sends" DROP CONSTRAINT "email_sends_kind_valid";--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_kind_valid" CHECK ("email_sends"."kind" IN ('briefing', 'evening_recap', 'approval', 'skill_documented', 'health_alert', 'workflow_blocked'));