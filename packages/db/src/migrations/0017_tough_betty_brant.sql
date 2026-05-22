CREATE TABLE "action_stagings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"integration" text NOT NULL,
	"risk_tier" text NOT NULL,
	"proposed_input" jsonb NOT NULL,
	"proposed_input_hash" text NOT NULL,
	"requires_approval" boolean NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_input" jsonb,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"executed_at" timestamp with time zone,
	"execute_result" jsonb,
	"execute_error" jsonb,
	"expires_at" timestamp with time zone,
	"notify_after_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_action_policies" (
	"user_id" text PRIMARY KEY NOT NULL,
	"default_mode" text DEFAULT 'gated' NOT NULL,
	"integration_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approval_notify_delay_ms" integer DEFAULT 300000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_prices" ADD COLUMN "context_window" integer;--> statement-breakpoint
ALTER TABLE "action_stagings" ADD CONSTRAINT "action_stagings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_stagings" ADD CONSTRAINT "action_stagings_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_action_policies" ADD CONSTRAINT "user_action_policies_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_stagings_run_tool_call_idx" ON "action_stagings" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "action_stagings_pending_user_idx" ON "action_stagings" USING btree ("user_id","status") WHERE "action_stagings"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "action_stagings_run_idx" ON "action_stagings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "action_stagings_rejected_retry_idx" ON "action_stagings" USING btree ("run_id","tool_name","proposed_input_hash") WHERE "action_stagings"."status" = 'rejected';