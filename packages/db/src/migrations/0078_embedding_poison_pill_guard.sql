ALTER TABLE "documents" ADD COLUMN "embed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "embed_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "last_embed_error" text;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD COLUMN "embed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD COLUMN "embed_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD COLUMN "last_embed_error" text;