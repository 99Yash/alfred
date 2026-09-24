CREATE TABLE "mcp_health_mapping" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"remote_name" text NOT NULL,
	"descriptor_hash" text NOT NULL,
	"mapping_revision" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "mcp_health_mapping" ADD CONSTRAINT "mcp_health_mapping_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_health_mapping" ADD CONSTRAINT "mcp_health_mapping_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The composite owner FK below requires this exact unique target on the
-- already-migrated connection table, so create it before adding the constraint.
CREATE UNIQUE INDEX "mcp_connections_id_user_idx" ON "mcp_connections" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "mcp_health_mapping" ADD CONSTRAINT "mcp_health_mapping_connection_owner_fk" FOREIGN KEY ("connection_id","user_id") REFERENCES "public"."mcp_connections"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_health_mapping_conn_remote_desc_idx" ON "mcp_health_mapping" USING btree ("connection_id","remote_name","descriptor_hash");--> statement-breakpoint
CREATE INDEX "mcp_health_mapping_owner_pair_idx" ON "mcp_health_mapping" USING btree ("user_id","connection_id","remote_name");