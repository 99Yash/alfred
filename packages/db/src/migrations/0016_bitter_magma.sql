CREATE TABLE "briefing_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"slot" text NOT NULL,
	"briefing_date" text NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"watermark_at" timestamp with time zone,
	"status" text DEFAULT 'composing' NOT NULL,
	"subject" text,
	"body_text" text,
	"body_html" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_run_id" text,
	"model_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "briefing_runs" ADD CONSTRAINT "briefing_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "briefing_runs_user_run_at_idx" ON "briefing_runs" USING btree ("user_id","run_at");--> statement-breakpoint
CREATE INDEX "briefing_runs_watermark_idx" ON "briefing_runs" USING btree ("user_id","slot","run_at") WHERE "briefing_runs"."status" = 'composed';--> statement-breakpoint
CREATE UNIQUE INDEX "briefing_runs_user_slot_date_idx" ON "briefing_runs" USING btree ("user_id","slot","briefing_date") WHERE "briefing_runs"."status" = 'composed';