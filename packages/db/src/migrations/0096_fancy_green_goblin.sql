CREATE UNIQUE INDEX "mcp_oauth_credentials_id_user_idx" ON "mcp_oauth_credentials" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_credential_owner_fk" FOREIGN KEY ("credential_id","user_id") REFERENCES "public"."mcp_oauth_credentials"("id","user_id") ON DELETE no action ON UPDATE no action;
