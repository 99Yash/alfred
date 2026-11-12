-- The GitHub MCP built-in moves from its own OAuth App (`GITHUB_MCP_CLIENT_ID`) to the
-- GitHub App's client (ADR-0093 amendment 2026-11-12). A token from the old client never
-- expires and has no refresh token, so nothing would move it to the new client. Clear the
-- grant and put the connection in front of the consent screen once (owner decision).
--
-- The clear includes a disconnected connection. A disconnect keeps the tokens, so a later
-- Connect would reuse the old grant. A disconnected connection stays disconnected.
--
-- The discovery cache stays: the issuer (`https://github.com/login/oauth`) does not change.
-- The catalog pointer stays: the endpoint does not change, and the App token lists the same
-- 28 read-only tools.
--
-- The GitHub identity rows drop their refresh token. The MCP row now owns it, and GitHub
-- rotates it on each use, so a second holder would end the grant on its first refresh.
--
-- One statement clears the grants and moves the connections. The move reads the `RETURNING`
-- rows of the clear, so it changes only a connection whose grant this run cleared, and it
-- skips a `disconnected` or `auth_required` connection. A grant that was already empty
-- before this migration is not cleared, so its connection keeps its status and error.
--
-- A second run before a new grant arrives finds no old token and no identity refresh token,
-- so it changes no row.
WITH "cleared" AS (
	UPDATE "mcp_oauth_credentials" o
	SET
		"access_token" = NULL,
		"refresh_token" = NULL,
		"id_token" = NULL,
		"client_information" = NULL,
		"client_secret" = NULL,
		"keepalive_failing_since" = NULL,
		"updated_at" = now()
	FROM "mcp_connections" c
	JOIN "mcp_servers" s ON s."id" = c."server_id"
	WHERE o."connection_id" = c."id"
		AND s."canonical_resource" = 'https://api.githubcopilot.com/mcp/readonly'
		AND o."access_token" IS NOT NULL
	RETURNING o."id", o."connection_id"
)
UPDATE "mcp_connections" c
SET
	"status" = 'auth_required',
	"last_error" = 'GitHub now connects through the Alfred GitHub App. Connect GitHub again.',
	"granted_scopes" = '[]'::jsonb,
	"required_scopes" = '[]'::jsonb,
	"updated_at" = now()
FROM "cleared"
WHERE c."id" = "cleared"."connection_id"
	AND c."credential_id" = "cleared"."id"
	AND c."status" NOT IN ('disconnected', 'auth_required');--> statement-breakpoint
UPDATE "integration_credentials"
SET
	"refresh_token" = NULL,
	"updated_at" = now()
WHERE "provider" = 'github'
	AND "refresh_token" IS NOT NULL;
