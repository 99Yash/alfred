ALTER TABLE "documents" ADD COLUMN "embed_first_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD COLUMN "embed_first_failed_at" timestamp with time zone;