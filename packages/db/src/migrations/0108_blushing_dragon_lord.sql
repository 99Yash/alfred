CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"canonical_resource" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"endpoint_origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
DROP INDEX "mcp_connections_user_resource_idx";--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "server_id" text;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "instance_key" text;--> statement-breakpoint
INSERT INTO "mcp_servers" (
	"id",
	"user_id",
	"canonical_resource",
	"endpoint_url",
	"endpoint_origin",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"user_id",
	"canonical_resource",
	"endpoint_url",
	"endpoint_origin",
	"created_at",
	"updated_at"
FROM "mcp_connections";--> statement-breakpoint
UPDATE "mcp_connections"
SET "server_id" = "id", "instance_key" = 'default';--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "mcp_connections" AS c
		LEFT JOIN "mcp_servers" AS s ON s."id" = c."server_id"
		WHERE c."server_id" IS NULL
			OR c."instance_key" IS NULL
			OR s."id" IS NULL
			OR s."user_id" <> c."user_id"
			OR s."canonical_resource" <> c."canonical_resource"
			OR s."endpoint_url" <> c."endpoint_url"
			OR s."endpoint_origin" <> c."endpoint_origin"
	) THEN
		RAISE EXCEPTION 'MCP server backfill verification failed';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "mcp_connections" ALTER COLUMN "server_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_connections" ALTER COLUMN "instance_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_user_resource_idx" ON "mcp_servers" USING btree ("user_id","canonical_resource");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_id_user_idx" ON "mcp_servers" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_server_owner_fk" FOREIGN KEY ("server_id","user_id") REFERENCES "public"."mcp_servers"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_user_server_instance_idx" ON "mcp_connections" USING btree ("user_id","server_id","instance_key");--> statement-breakpoint
ALTER TABLE "mcp_connections" DROP COLUMN "canonical_resource";--> statement-breakpoint
ALTER TABLE "mcp_connections" DROP COLUMN "endpoint_url";--> statement-breakpoint
ALTER TABLE "mcp_connections" DROP COLUMN "endpoint_origin";
