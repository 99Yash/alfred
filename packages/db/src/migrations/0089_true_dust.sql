CREATE TABLE "mcp_oauth_authorization_attempts" (
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
CREATE TABLE "mcp_oauth_credentials" (
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
ALTER TABLE "mcp_connections" ADD COLUMN "required_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorization_attempts" ADD CONSTRAINT "mcp_oauth_authorization_attempts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorization_attempts" ADD CONSTRAINT "mcp_oauth_authorization_attempts_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_credentials" ADD CONSTRAINT "mcp_oauth_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_credentials" ADD CONSTRAINT "mcp_oauth_credentials_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_attempts_state_idx" ON "mcp_oauth_authorization_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_attempts_connection_idx" ON "mcp_oauth_authorization_attempts" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_credentials_connection_idx" ON "mcp_oauth_credentials" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_credentials_user_issuer_idx" ON "mcp_oauth_credentials" USING btree ("user_id","issuer");--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_credential_id_mcp_oauth_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."mcp_oauth_credentials"("id") ON DELETE set null ON UPDATE no action;