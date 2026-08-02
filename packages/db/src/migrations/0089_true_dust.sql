-- This migration was generated after an earlier migration with the same index
-- reached development databases. Converge both the fresh and legacy shapes.
CREATE TABLE IF NOT EXISTS "mcp_oauth_authorization_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"code_verifier" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"issuer" text NOT NULL,
	"discovery_state" jsonb,
	"client_information" jsonb,
	"client_secret" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"token_type" text,
	"expires_in" integer,
	"scope" text,
	"last_authorized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN IF NOT EXISTS "required_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_credentials" ADD COLUMN IF NOT EXISTS "connection_id" text;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "mcp_connections"
		WHERE "credential_id" IS NOT NULL
		GROUP BY "credential_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'cannot migrate shared MCP OAuth credentials: more than one mcp_connections row uses the same credential';
	END IF;
END $$;--> statement-breakpoint
UPDATE "mcp_oauth_credentials" AS credential
SET "connection_id" = connection."id"
FROM "mcp_connections" AS connection
WHERE connection."credential_id" = credential."id"
	AND credential."connection_id" IS NULL;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "mcp_oauth_credentials" WHERE "connection_id" IS NULL) THEN
		RAISE EXCEPTION 'cannot migrate orphaned MCP OAuth credentials: no owning mcp_connections row';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "mcp_oauth_credentials" ALTER COLUMN "connection_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_oauth_credentials_state_idx";--> statement-breakpoint
ALTER TABLE "mcp_oauth_credentials" DROP COLUMN IF EXISTS "code_verifier";--> statement-breakpoint
ALTER TABLE "mcp_oauth_credentials" DROP COLUMN IF EXISTS "oauth_state_hash";--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_oauth_authorization_attempts_user_id_user_id_fk' AND conrelid = 'mcp_oauth_authorization_attempts'::regclass) THEN
		ALTER TABLE "mcp_oauth_authorization_attempts" ADD CONSTRAINT "mcp_oauth_authorization_attempts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_oauth_authorization_attempts_connection_id_mcp_connections_id_fk' AND conrelid = 'mcp_oauth_authorization_attempts'::regclass) THEN
		ALTER TABLE "mcp_oauth_authorization_attempts" ADD CONSTRAINT "mcp_oauth_authorization_attempts_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_oauth_credentials_user_id_user_id_fk' AND conrelid = 'mcp_oauth_credentials'::regclass) THEN
		ALTER TABLE "mcp_oauth_credentials" ADD CONSTRAINT "mcp_oauth_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_oauth_credentials_connection_id_mcp_connections_id_fk' AND conrelid = 'mcp_oauth_credentials'::regclass) THEN
		ALTER TABLE "mcp_oauth_credentials" ADD CONSTRAINT "mcp_oauth_credentials_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_connections_credential_id_mcp_oauth_credentials_id_fk' AND conrelid = 'mcp_connections'::regclass) THEN
		ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_credential_id_mcp_oauth_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."mcp_oauth_credentials"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_attempts_state_idx" ON "mcp_oauth_authorization_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_attempts_connection_idx" ON "mcp_oauth_authorization_attempts" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_credentials_connection_idx" ON "mcp_oauth_credentials" USING btree ("connection_id");--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_oauth_credentials_user_issuer_idx";--> statement-breakpoint
CREATE INDEX "mcp_oauth_credentials_user_issuer_idx" ON "mcp_oauth_credentials" USING btree ("user_id","issuer");
