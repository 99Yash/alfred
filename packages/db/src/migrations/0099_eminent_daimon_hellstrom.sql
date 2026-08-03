ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_kind_valid" CHECK ("email_sends"."kind" IN ('briefing', 'evening_recap', 'approval', 'skill_documented', 'health_alert'));--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_status_valid" CHECK ("email_sends"."status" IN ('queued', 'sent', 'failed'));--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_status_valid" CHECK ("todos"."status" IN ('suggested', 'open', 'done', 'dismissed', 'cleared'));--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_kind_valid" CHECK ("todos"."kind" IN ('task'));--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_created_by_valid" CHECK ("todos"."created_by" IN ('user', 'agent'));--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_executor_valid" CHECK ("todos"."executor" IN ('user', 'agent'));