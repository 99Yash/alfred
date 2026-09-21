CREATE TABLE "mcp_api_key_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"placement" jsonb NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "api_key_credential_id" text;--> statement-breakpoint
ALTER TABLE "mcp_api_key_credentials" ADD CONSTRAINT "mcp_api_key_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_api_key_credentials" ADD CONSTRAINT "mcp_api_key_credentials_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_api_key_credentials_connection_idx" ON "mcp_api_key_credentials" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_api_key_credentials_id_user_idx" ON "mcp_api_key_credentials" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_api_key_credentials_id_connection_idx" ON "mcp_api_key_credentials" USING btree ("id","connection_id");--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_api_key_credential_id_mcp_api_key_credentials_id_fk" FOREIGN KEY ("api_key_credential_id") REFERENCES "public"."mcp_api_key_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_api_key_credential_owner_fk" FOREIGN KEY ("api_key_credential_id","user_id") REFERENCES "public"."mcp_api_key_credentials"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_api_key_credential_connection_fk" FOREIGN KEY ("api_key_credential_id","id") REFERENCES "public"."mcp_api_key_credentials"("id","connection_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_single_credential_chk" CHECK (num_nonnulls("mcp_connections"."credential_id", "mcp_connections"."api_key_credential_id") <= 1);