ALTER TABLE "documents" DROP CONSTRAINT "documents_source_valid";--> statement-breakpoint
ALTER TABLE "integration_credentials" DROP CONSTRAINT "integration_credentials_provider_valid";--> statement-breakpoint
ALTER TABLE "email_sends" DROP CONSTRAINT "email_sends_kind_valid";--> statement-breakpoint
ALTER TABLE "email_sends" DROP CONSTRAINT "email_sends_status_valid";--> statement-breakpoint
ALTER TABLE "sender_priors" DROP CONSTRAINT "sender_priors_last_category_valid";--> statement-breakpoint
ALTER TABLE "todos" DROP CONSTRAINT "todos_status_valid";--> statement-breakpoint
ALTER TABLE "todos" DROP CONSTRAINT "todos_created_by_valid";--> statement-breakpoint
ALTER TABLE "todos" DROP CONSTRAINT "todos_executor_valid";--> statement-breakpoint
ALTER TABLE "email_triage" DROP CONSTRAINT "email_triage_category_valid";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_valid" CHECK ("documents"."source" IN ('github', 'gmail', 'gmail_attachment', 'sentry'));--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_provider_valid" CHECK ("integration_credentials"."provider" IN ('github', 'google', 'notion', 'railway', 'sentry', 'vercel'));--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_kind_valid" CHECK ("email_sends"."kind" IN ('approval', 'briefing', 'evening_recap', 'health_alert', 'skill_documented', 'workflow_blocked'));--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_status_valid" CHECK ("email_sends"."status" IN ('failed', 'queued', 'sent'));--> statement-breakpoint
ALTER TABLE "sender_priors" ADD CONSTRAINT "sender_priors_last_category_valid" CHECK ("sender_priors"."last_category" IN ('action_needed', 'awaiting_reply', 'done', 'follow_up', 'fyi', 'marketing', 'meeting', 'newsletter', 'payment', 'urgent'));--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_status_valid" CHECK ("todos"."status" IN ('cleared', 'dismissed', 'done', 'open', 'suggested'));--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_created_by_valid" CHECK ("todos"."created_by" IN ('agent', 'user'));--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_executor_valid" CHECK ("todos"."executor" IN ('agent', 'user'));--> statement-breakpoint
ALTER TABLE "email_triage" ADD CONSTRAINT "email_triage_category_valid" CHECK ("email_triage"."category" IN ('action_needed', 'awaiting_reply', 'done', 'follow_up', 'fyi', 'marketing', 'meeting', 'newsletter', 'payment', 'urgent'));