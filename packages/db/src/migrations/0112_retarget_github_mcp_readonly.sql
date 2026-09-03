-- Retarget the built-in GitHub MCP server row to the READ-ONLY path.
--
-- `GITHUB_MCP_ENDPOINT_HREF` moved from `https://api.githubcopilot.com/mcp` to
-- `https://api.githubcopilot.com/mcp/readonly`, because the catalog GitHub
-- returns is filtered by the token's scopes and the read-write root hands a
-- `repo`-scoped token 16 write tools that ADR-0052 says Alfred must not hold.
--
-- That href is the canonical resource, which is the durable identity of the
-- `mcp_servers` row: without this update `ensureBuiltInConnection` would mint a
-- SECOND server and a second connection for the new resource and leave the old
-- pair behind, where `/integrations` picks whichever row was written last.
-- Moving the row in place keeps the connection id, the catalog pointer, and the
-- sealed credential attached to the one slot the user already owns.
--
-- Nothing else needs resetting. The stored grant carries no scope, so the next
-- authorize sees an ask wider than the grant and forces a fresh consent, and
-- the manager republishes the catalog on the next connect.
--
-- Idempotent: it matches only the old resource, and it refuses to collide with
-- a row that already holds the new one.
UPDATE "mcp_servers" AS s
SET
	"canonical_resource" = 'https://api.githubcopilot.com/mcp/readonly',
	"endpoint_url" = 'https://api.githubcopilot.com/mcp/readonly',
	"updated_at" = now()
WHERE s."canonical_resource" = 'https://api.githubcopilot.com/mcp'
	AND NOT EXISTS (
		SELECT 1
		FROM "mcp_servers" AS existing
		WHERE existing."user_id" = s."user_id"
			AND existing."canonical_resource" = 'https://api.githubcopilot.com/mcp/readonly'
	);
