CREATE TABLE "agent_decision_traces" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workflow_slug" text NOT NULL,
	"step_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"kind" text NOT NULL,
	"trace" jsonb NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "agent_decision_traces" ADD CONSTRAINT "agent_decision_traces_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_decision_traces" ADD CONSTRAINT "agent_decision_traces_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_decision_traces_idem_idx" ON "agent_decision_traces" USING btree ("run_id","step_id","attempt","kind");--> statement-breakpoint
CREATE INDEX "agent_decision_traces_user_kind_idx" ON "agent_decision_traces" USING btree ("user_id","kind","decided_at");--> statement-breakpoint
CREATE INDEX "agent_decision_traces_workflow_kind_idx" ON "agent_decision_traces" USING btree ("workflow_slug","kind","decided_at");