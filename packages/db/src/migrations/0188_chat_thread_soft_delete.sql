DROP INDEX "chat_threads_user_last_idx";--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "chat_threads_user_last_idx" ON "chat_threads" USING btree ("user_id","last_message_at") WHERE "chat_threads"."deleted_at" IS NULL;