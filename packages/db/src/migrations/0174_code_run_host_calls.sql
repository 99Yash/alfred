CREATE TABLE "code_run_host_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"parent_staging_id" text NOT NULL,
	"request_index" integer NOT NULL,
	"path" text NOT NULL,
	"tool_name" text,
	"call_id" text,
	"arguments" jsonb,
	"nested_staging_id" text,
	"outcome" text NOT NULL,
	"refusal_message" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"omitted_evidence" integer DEFAULT 0 NOT NULL,
	"content_hash" text,
	"coverage" jsonb,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_run_host_calls_outcome_valid" CHECK ("code_run_host_calls"."outcome" IN ('binary_output', 'blocked', 'executed', 'failed', 'feature_disabled', 'fenced', 'invalid_input', 'needs_approval', 'not_a_read', 'not_allowed', 'output_too_large', 'rejected', 'route_changed', 'tool_error', 'undeclared_output', 'unfinished', 'unknown_tool'))
);
--> statement-breakpoint
ALTER TABLE "code_run_host_calls" ADD CONSTRAINT "code_run_host_calls_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_run_host_calls" ADD CONSTRAINT "code_run_host_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_run_host_calls" ADD CONSTRAINT "code_run_host_calls_parent_staging_id_action_stagings_id_fk" FOREIGN KEY ("parent_staging_id") REFERENCES "public"."action_stagings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_run_host_calls" ADD CONSTRAINT "code_run_host_calls_nested_staging_id_action_stagings_id_fk" FOREIGN KEY ("nested_staging_id") REFERENCES "public"."action_stagings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "code_run_host_calls_parent_request_idx" ON "code_run_host_calls" USING btree ("parent_staging_id","request_index");--> statement-breakpoint
CREATE INDEX "code_run_host_calls_run_idx" ON "code_run_host_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "code_run_host_calls_nested_staging_idx" ON "code_run_host_calls" USING btree ("nested_staging_id");