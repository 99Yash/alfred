-- MCP OAuth keep-alive bookkeeping. Both columns are nullable and hold no token.
-- `keepalive_attempted_at` rotates a failing row to the back of the hourly page.
-- `keepalive_failing_since` opens a failure run; after 72 hours the row moves to auth_required.
ALTER TABLE "mcp_oauth_credentials" ADD COLUMN "keepalive_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_oauth_credentials" ADD COLUMN "keepalive_failing_since" timestamp with time zone;
