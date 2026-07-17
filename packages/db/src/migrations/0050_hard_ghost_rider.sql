CREATE TABLE "active_projection_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"projection_name" text NOT NULL,
	"active_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "entity_co_occurrence" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"projection_version" integer NOT NULL,
	"a_entity_id" text NOT NULL,
	"b_entity_id" text NOT NULL,
	"weight" real DEFAULT 0 NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"family_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "entity_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"projection_version" integer NOT NULL,
	"from_entity_id" text NOT NULL,
	"to_entity_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"weight" real DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "entity_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"user_pinned" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"supersedes_id" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "entity_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"canonical_identity" jsonb NOT NULL,
	"supersedes_entity_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "entity_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"projection_version" integer NOT NULL,
	"entity_id" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"significance_components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"family_key" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"dedup_key" text NOT NULL,
	"subject_identity" jsonb NOT NULL,
	"object_identity" jsonb,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"reducer_version" integer DEFAULT 1 NOT NULL,
	"supersedes_observation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "projection_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"projection_name" text NOT NULL,
	"source" text NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "projection_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"projection_name" text NOT NULL,
	"projection_version" integer NOT NULL,
	"source_high_watermark" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checksum" text,
	"row_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "projection_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sync_slug" text NOT NULL,
	"stable_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "active_projection_versions" ADD CONSTRAINT "active_projection_versions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_a_entity_id_entity_nodes_id_fk" FOREIGN KEY ("a_entity_id") REFERENCES "public"."entity_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_b_entity_id_entity_nodes_id_fk" FOREIGN KEY ("b_entity_id") REFERENCES "public"."entity_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_from_entity_id_entity_nodes_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."entity_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_to_entity_id_entity_nodes_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."entity_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identities" ADD CONSTRAINT "entity_identities_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identities" ADD CONSTRAINT "entity_identities_entity_id_entity_nodes_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_nodes" ADD CONSTRAINT "entity_nodes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_profiles" ADD CONSTRAINT "entity_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_profiles" ADD CONSTRAINT "entity_profiles_entity_id_entity_nodes_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_cursors" ADD CONSTRAINT "projection_cursors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_runs" ADD CONSTRAINT "projection_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_sync_state" ADD CONSTRAINT "projection_sync_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "active_projection_versions_unique_idx" ON "active_projection_versions" USING btree ("user_id","projection_name");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_co_occurrence_pair_idx" ON "entity_co_occurrence" USING btree ("user_id","projection_version","a_entity_id","b_entity_id");--> statement-breakpoint
CREATE INDEX "entity_co_occurrence_weight_idx" ON "entity_co_occurrence" USING btree ("user_id","projection_version","weight");--> statement-breakpoint
ALTER TABLE "entity_co_occurrence" ADD CONSTRAINT "entity_co_occurrence_pair_order" CHECK ("entity_co_occurrence"."a_entity_id" < "entity_co_occurrence"."b_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_edges_unique_idx" ON "entity_edges" USING btree ("user_id","projection_version","relation_type","from_entity_id","to_entity_id");--> statement-breakpoint
CREATE INDEX "entity_edges_from_idx" ON "entity_edges" USING btree ("user_id","projection_version","from_entity_id");--> statement-breakpoint
CREATE INDEX "entity_edges_to_idx" ON "entity_edges" USING btree ("user_id","projection_version","to_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_identities_unique_idx" ON "entity_identities" USING btree ("user_id","kind","value");--> statement-breakpoint
CREATE INDEX "entity_identities_entity_idx" ON "entity_identities" USING btree ("user_id","entity_id");--> statement-breakpoint
CREATE INDEX "entity_nodes_user_idx" ON "entity_nodes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "entity_nodes_supersedes_idx" ON "entity_nodes" USING btree ("supersedes_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_profiles_version_idx" ON "entity_profiles" USING btree ("user_id","projection_version","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "observations_dedup_idx" ON "observations" USING btree ("user_id","dedup_key");--> statement-breakpoint
CREATE INDEX "observations_source_time_idx" ON "observations" USING btree ("user_id","source","occurred_at");--> statement-breakpoint
CREATE INDEX "observations_family_idx" ON "observations" USING btree ("user_id","family_key");--> statement-breakpoint
CREATE UNIQUE INDEX "projection_cursors_unique_idx" ON "projection_cursors" USING btree ("user_id","projection_name","source");--> statement-breakpoint
CREATE INDEX "projection_runs_name_idx" ON "projection_runs" USING btree ("user_id","projection_name","projection_version");--> statement-breakpoint
CREATE UNIQUE INDEX "projection_sync_state_unique_idx" ON "projection_sync_state" USING btree ("user_id","sync_slug","stable_key");--> statement-breakpoint
CREATE INDEX "projection_sync_state_slug_idx" ON "projection_sync_state" USING btree ("user_id","sync_slug");
