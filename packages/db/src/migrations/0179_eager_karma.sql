DROP INDEX "artifacts_user_idx";--> statement-breakpoint
DROP INDEX "chat_attachments_user_idx";--> statement-breakpoint
DROP INDEX "chat_messages_user_idx";--> statement-breakpoint
DROP INDEX "chat_thread_context_user_idx";--> statement-breakpoint
DROP INDEX "drift_metrics_user_metric_idx";--> statement-breakpoint
DROP INDEX "api_call_log_kind_created_idx";--> statement-breakpoint
CREATE INDEX "agent_runs_chat_thread_history_idx" ON "agent_runs" USING btree ("user_id","workflow_slug",("metadata" ->> 'threadId'),"created_at") WHERE ("agent_runs"."metadata" ->> 'threadId') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "artifacts_user_created_idx" ON "artifacts" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "chat_attachments_user_created_idx" ON "chat_attachments" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "chat_messages_user_created_idx" ON "chat_messages" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "documents_user_authored_idx" ON "documents" USING btree ("user_id","authored_at");--> statement-breakpoint
CREATE INDEX "events_outbox_published_idx" ON "events_outbox" USING btree ("id") WHERE "events_outbox"."published_at" IS NOT NULL;