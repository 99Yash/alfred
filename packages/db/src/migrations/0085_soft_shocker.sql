CREATE TABLE "mcp_catalog_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"revision_hash" text NOT NULL,
	"descriptors" jsonb NOT NULL,
	"descriptor_hashes" jsonb NOT NULL,
	"tool_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"canonical_resource" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"endpoint_origin" text NOT NULL,
	"auth_server_identity" text,
	"credential_id" text,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"negotiated_protocol_version" text,
	"server_identity" jsonb,
	"current_catalog_revision_id" text,
	"last_connected_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "mcp_invocation" (
	"id" text PRIMARY KEY NOT NULL,
	"staging_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"remote_name" text NOT NULL,
	"catalog_revision_id" text,
	"descriptor_hash" text,
	"policy_revision" integer,
	"args_hash" text NOT NULL,
	"effect_class" text DEFAULT 'unknown' NOT NULL,
	"attempt_lifecycle" text DEFAULT 'prepared' NOT NULL,
	"effect_outcome" text,
	"retry_disposition" text,
	"successor_of" text,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "mcp_tool_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"remote_name" text NOT NULL,
	"descriptor_hash" text NOT NULL,
	"policy_revision" integer DEFAULT 1 NOT NULL,
	"risk_tier" text NOT NULL,
	"effect_class" text DEFAULT 'unknown' NOT NULL,
	"retry_contract" text DEFAULT 'never' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "mcp_catalog_revisions" ADD CONSTRAINT "mcp_catalog_revisions_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_invocation" ADD CONSTRAINT "mcp_invocation_staging_id_action_stagings_id_fk" FOREIGN KEY ("staging_id") REFERENCES "public"."action_stagings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_invocation" ADD CONSTRAINT "mcp_invocation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_invocation" ADD CONSTRAINT "mcp_invocation_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_invocation" ADD CONSTRAINT "mcp_invocation_catalog_revision_id_mcp_catalog_revisions_id_fk" FOREIGN KEY ("catalog_revision_id") REFERENCES "public"."mcp_catalog_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_invocation" ADD CONSTRAINT "mcp_invocation_successor_of_fk" FOREIGN KEY ("successor_of") REFERENCES "public"."mcp_invocation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_policy" ADD CONSTRAINT "mcp_tool_policy_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_policy" ADD CONSTRAINT "mcp_tool_policy_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_catalog_revisions_conn_hash_idx" ON "mcp_catalog_revisions" USING btree ("connection_id","revision_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_catalog_revisions_conn_id_idx" ON "mcp_catalog_revisions" USING btree ("connection_id","id");--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_current_revision_fk" FOREIGN KEY ("id","current_catalog_revision_id") REFERENCES "public"."mcp_catalog_revisions"("connection_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_user_resource_idx" ON "mcp_connections" USING btree ("user_id","canonical_resource");--> statement-breakpoint
CREATE INDEX "mcp_connections_user_status_idx" ON "mcp_connections" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_invocation_staging_idx" ON "mcp_invocation" USING btree ("staging_id");--> statement-breakpoint
CREATE INDEX "mcp_invocation_barrier_lookup_idx" ON "mcp_invocation" USING btree ("connection_id","remote_name","args_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_invocation_unresolved_barrier_idx" ON "mcp_invocation" USING btree ("user_id","connection_id","remote_name","args_hash") WHERE "mcp_invocation"."resolved_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tool_policy_conn_remote_desc_idx" ON "mcp_tool_policy" USING btree ("connection_id","remote_name","descriptor_hash");