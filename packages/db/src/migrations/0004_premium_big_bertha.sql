CREATE TABLE "api_call_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_input_tokens" integer,
	"cost_usd" numeric(12, 8) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"user_id" text,
	"run_id" text,
	"step_id" text,
	"attempt" integer,
	"message_id" text,
	"request_meta" jsonb,
	"response_meta" jsonb,
	"error" jsonb
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"input_per_mtok" numeric(12, 6) NOT NULL,
	"output_per_mtok" numeric(12, 6) NOT NULL,
	"cached_input_per_mtok" numeric(12, 6),
	"per_call_usd" numeric(12, 6),
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_call_log" ADD CONSTRAINT "api_call_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_call_log_run_idx" ON "api_call_log" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "api_call_log_user_created_idx" ON "api_call_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "api_call_log_kind_created_idx" ON "api_call_log" USING btree ("kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_prices_versioned_idx" ON "model_prices" USING btree ("provider","model","valid_from");--> statement-breakpoint
CREATE INDEX "model_prices_lookup_idx" ON "model_prices" USING btree ("provider","model","valid_from");