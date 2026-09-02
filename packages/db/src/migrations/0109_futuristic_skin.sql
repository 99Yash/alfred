CREATE UNIQUE INDEX "mcp_oauth_credentials_id_connection_idx" ON "mcp_oauth_credentials" USING btree ("id","connection_id");--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_credential_connection_fk" FOREIGN KEY ("credential_id","id") REFERENCES "public"."mcp_oauth_credentials"("id","connection_id") ON DELETE no action ON UPDATE no action;
