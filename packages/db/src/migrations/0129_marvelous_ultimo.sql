ALTER TABLE "shared_threads" ADD COLUMN "snapshot_digest" text NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_threads" ADD COLUMN "message_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_threads" ADD COLUMN "artifact_count" integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shared_threads_thread_digest_idx" ON "shared_threads" USING btree ("source_thread_id","snapshot_digest");