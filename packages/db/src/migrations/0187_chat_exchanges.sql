CREATE TABLE "chat_exchanges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"user_message_id" text NOT NULL,
	"reply_message_id" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024),
	"embed_attempts" integer DEFAULT 0 NOT NULL,
	"embed_first_failed_at" timestamp with time zone,
	"embed_failed_at" timestamp with time zone,
	"last_embed_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "chat_exchanges" ADD CONSTRAINT "chat_exchanges_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_exchanges" ADD CONSTRAINT "chat_exchanges_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_exchanges" ADD CONSTRAINT "chat_exchanges_user_message_id_chat_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_exchanges" ADD CONSTRAINT "chat_exchanges_reply_message_id_chat_messages_id_fk" FOREIGN KEY ("reply_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_exchanges_user_message_idx" ON "chat_exchanges" USING btree ("user_message_id");--> statement-breakpoint
CREATE INDEX "chat_exchanges_reply_message_idx" ON "chat_exchanges" USING btree ("reply_message_id");--> statement-breakpoint
CREATE INDEX "chat_exchanges_user_thread_idx" ON "chat_exchanges" USING btree ("user_id","thread_id");--> statement-breakpoint
CREATE INDEX "chat_exchanges_embed_sweep_idx" ON "chat_exchanges" USING btree ("id") WHERE "chat_exchanges"."embedding" IS NULL AND "chat_exchanges"."embed_failed_at" IS NULL;--> statement-breakpoint
-- HNSW index for semantic recall over past chats (journal.md section 3, ADR-0021).
-- Same shape as `chunks_embedding_hnsw_idx` after 0165: a halfvec expression and
-- ef_construction 64. It lives only in migration SQL, as for `chunks`.
CREATE INDEX "chat_exchanges_embedding_hnsw_idx" ON "chat_exchanges" USING hnsw (((embedding)::halfvec(1024)) halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
