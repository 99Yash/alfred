CREATE TABLE "result_handles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"query" text NOT NULL,
	"item_count" integer,
	"byte_size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "result_handles" ADD CONSTRAINT "result_handles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_handles" ADD CONSTRAINT "result_handles_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_handles" ADD CONSTRAINT "result_handles_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "result_handles_run_call_idx" ON "result_handles" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "result_handles_thread_message_idx" ON "result_handles" USING btree ("thread_id","message_id");--> statement-breakpoint
CREATE INDEX "result_handles_expires_idx" ON "result_handles" USING btree ("expires_at");