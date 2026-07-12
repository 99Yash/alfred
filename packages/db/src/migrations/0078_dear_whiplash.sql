CREATE TABLE IF NOT EXISTS "chat_thread_context" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"summary" jsonb,
	"summary_watermark_created_at" timestamp with time zone,
	"summary_watermark_message_id" text,
	"estimated_replay_tokens" integer DEFAULT 0 NOT NULL,
	"compaction_requested_at" timestamp with time zone,
	"compaction_completed_at" timestamp with time zone,
	"compaction_failed_at" timestamp with time zone,
	"compaction_failure_category" text,
	"compaction_failure_message" text,
	"compaction_generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp,
	CONSTRAINT "chat_thread_context_watermark_pair_chk" CHECK (("chat_thread_context"."summary_watermark_created_at" IS NULL) = ("chat_thread_context"."summary_watermark_message_id" IS NULL)),
	CONSTRAINT "chat_thread_context_estimated_tokens_chk" CHECK ("chat_thread_context"."estimated_replay_tokens" >= 0),
	CONSTRAINT "chat_thread_context_generation_chk" CHECK ("chat_thread_context"."compaction_generation" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'chat_thread_context_thread_id_chat_threads_id_fk'
			AND conrelid = 'public.chat_thread_context'::regclass
	) THEN
		ALTER TABLE "chat_thread_context" ADD CONSTRAINT "chat_thread_context_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'chat_thread_context_user_id_user_id_fk'
			AND conrelid = 'public.chat_thread_context'::regclass
	) THEN
		ALTER TABLE "chat_thread_context" ADD CONSTRAINT "chat_thread_context_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_thread_context_user_idx" ON "chat_thread_context" USING btree ("user_id");
