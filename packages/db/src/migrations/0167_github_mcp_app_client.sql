-- The GitHub MCP built-in moves from its own OAuth App (`GITHUB_MCP_CLIENT_ID`) to the
-- GitHub App's client (ADR-0093 amendment 2026-11-12). A token from the old client never
-- expires and has no refresh token, so nothing would move it to the new client. Clear the
-- grant and put the connection in front of the consent screen once (owner decision).
--
-- The discovery cache stays: the issuer (`https://github.com/login/oauth`) does not change.
-- The catalog pointer stays: the endpoint does not change, and the App token lists the same
-- 28 read-only tools.
--
-- The GitHub identity rows drop their refresh token. The MCP row now owns it, and GitHub
-- rotates it on each use, so a second holder would end the grant on its first refresh.
--
-- Idempotent: a second run finds no token on the old grant and no refresh token on an
-- identity row. It moves a connection only while its grant holds no access token.
UPDATE "mcp_oauth_credentials"
SET
	"access_token" = NULL,
	"refresh_token" = NULL,
	"id_token" = NULL,
	"client_information" = NULL,
	"client_secret" = NULL,
	"keepalive_failing_since" = NULL,
	"updated_at" = now()
WHERE "connection_id" IN (
	SELECT c."id"
	FROM "mcp_connections" c
	JOIN "mcp_servers" s ON s."id" = c."server_id"
	WHERE s."canonical_resource" = 'https://api.githubcopilot.com/mcp/readonly'
		AND c."status" <> 'disconnected'
)
	AND "access_token" IS NOT NULL;--> statement-breakpoint
UPDATE "mcp_connections"
SET
	"status" = 'auth_required',
	"last_error" = 'GitHub now connects through the Alfred GitHub App. Connect GitHub again.',
	"granted_scopes" = '[]'::jsonb,
	"required_scopes" = '[]'::jsonb,
	"updated_at" = now()
WHERE "server_id" IN (
	SELECT "id" FROM "mcp_servers"
	WHERE "canonical_resource" = 'https://api.githubcopilot.com/mcp/readonly'
)
	AND "status" NOT IN ('disconnected', 'auth_required')
	AND "credential_id" IN (
		SELECT "id" FROM "mcp_oauth_credentials" WHERE "access_token" IS NULL
	);--> statement-breakpoint
UPDATE "integration_credentials"
SET
	"refresh_token" = NULL,
	"updated_at" = now()
WHERE "provider" = 'github'
	AND "refresh_token" IS NOT NULL;
