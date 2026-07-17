CREATE TABLE "chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"token_count" integer,
	"content_hash" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"source_thread_id" text,
	"account_id" text,
	"title" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"raw" jsonb,
	"url" text,
	"authored_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "ingestion_state" (
	"id" text PRIMARY KEY NOT NULL,
	"credential_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"stream" text DEFAULT 'messages' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"account_label" text,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"token_type" text DEFAULT 'Bearer',
	"expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_state" ADD CONSTRAINT "ingestion_state_credential_id_integration_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."integration_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_state" ADD CONSTRAINT "ingestion_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_position_idx" ON "chunks" USING btree ("document_id","position");--> statement-breakpoint
CREATE INDEX "chunks_user_idx" ON "chunks" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_source_id_idx" ON "documents" USING btree ("user_id","source","source_id");--> statement-breakpoint
CREATE INDEX "documents_user_source_idx" ON "documents" USING btree ("user_id","source","authored_at");--> statement-breakpoint
CREATE INDEX "documents_thread_idx" ON "documents" USING btree ("user_id","source","source_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_state_unique_idx" ON "ingestion_state" USING btree ("credential_id","stream");--> statement-breakpoint
CREATE INDEX "ingestion_state_user_idx" ON "ingestion_state" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_credentials_unique_idx" ON "integration_credentials" USING btree ("user_id","provider","account_id");--> statement-breakpoint
CREATE INDEX "integration_credentials_user_idx" ON "integration_credentials" USING btree ("user_id","provider");--> statement-breakpoint
-- HNSW index for semantic search over chunk embeddings (ADR-0021).
-- m=16, ef_construction=200 are the ADR's defaults; ef_search is set per-query.
-- The column is nullable; HNSW skips NULL rows so an empty m7a corpus is harmless.
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 200);