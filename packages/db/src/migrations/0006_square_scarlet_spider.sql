CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"canonical_name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "entity_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"from_entity_id" text NOT NULL,
	"to_entity_id" text NOT NULL,
	"relation" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "memory_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"content_hash" text NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "rejected_inferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value_signature" text NOT NULL,
	"proposed_fact_id" text,
	"reason" jsonb,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "style_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"audience_bucket" text NOT NULL,
	"recipient_id" text,
	"profile_doc" text NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_msg_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp with time zone,
	"generated_from_count" integer DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"superseded_by_id" text,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "user_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"supersedes_id" text,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_from_entity_id_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_to_entity_id_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejected_inferences" ADD CONSTRAINT "rejected_inferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_profiles" ADD CONSTRAINT "style_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_facts" ADD CONSTRAINT "user_facts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entities_canonical_idx" ON "entities" USING btree ("user_id","kind","canonical_name");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_relations_unique_idx" ON "entity_relations" USING btree ("user_id","from_entity_id","to_entity_id","relation");--> statement-breakpoint
CREATE INDEX "entity_relations_from_idx" ON "entity_relations" USING btree ("user_id","from_entity_id");--> statement-breakpoint
CREATE INDEX "entity_relations_to_idx" ON "entity_relations" USING btree ("user_id","to_entity_id");--> statement-breakpoint
CREATE INDEX "memory_chunks_user_kind_idx" ON "memory_chunks" USING btree ("user_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_chunks_hash_idx" ON "memory_chunks" USING btree ("user_id","kind","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "rejected_inferences_signature_idx" ON "rejected_inferences" USING btree ("user_id","key","value_signature");--> statement-breakpoint
CREATE INDEX "rejected_inferences_key_idx" ON "rejected_inferences" USING btree ("user_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "style_profiles_unique_idx" ON "style_profiles" USING btree ("user_id","channel","audience_bucket","recipient_id");--> statement-breakpoint
CREATE INDEX "style_profiles_lookup_idx" ON "style_profiles" USING btree ("user_id","channel","status");--> statement-breakpoint
CREATE INDEX "user_facts_key_idx" ON "user_facts" USING btree ("user_id","key","status");--> statement-breakpoint
CREATE INDEX "user_facts_status_idx" ON "user_facts" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "user_facts_supersedes_idx" ON "user_facts" USING btree ("supersedes_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_unique_idx" ON "user_preferences" USING btree ("user_id","key");--> statement-breakpoint
-- HNSW index for semantic recall over memory_chunks (ADR-0021).
-- Same defaults as `chunks_embedding_hnsw_idx` in 0005; ef_search is per-query.
CREATE INDEX "memory_chunks_embedding_hnsw_idx" ON "memory_chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 200);