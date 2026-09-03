-- Retarget the built-in GitHub MCP server row to the READ-ONLY path, and put
-- the connection that owns it back in front of the consent screen.
--
-- `GITHUB_MCP_ENDPOINT_HREF` moved from `https://api.githubcopilot.com/mcp` to
-- `https://api.githubcopilot.com/mcp/readonly` (ADR-0094). That href is the
-- canonical resource, which is the durable identity of the `mcp_servers` row:
-- without this update `ensureBuiltInConnection` would mint a SECOND server and
-- a second connection for the new resource and leave the old pair behind, where
-- `/integrations` picks whichever row was written last. Moving the row in place
-- keeps the connection id, the sealed credential, and the one slot the user
-- already owns.
--
-- The connection rows need three edits of their own, because the code path that
-- widens the scope ask only runs when the user clicks Connect:
--
--   * `status = 'auth_required'` — a row left at `ready` renders "Connected",
--     so nothing ever asks for the click, and a background reconnect just
--     republishes the old catalog. `auth_required` is what makes the card show
--     the reconnect action.
--   * `last_error` — the card states the reason from this column.
--   * `current_catalog_revision_id = NULL` — the stored revision was captured
--     against the old resource with an empty-scope token, so it is stale by
--     construction. Dropping the pointer means the boss sees NO GitHub MCP
--     tools until the reconnect republishes, instead of a catalog that cannot
--     read a pull request.
--
-- The sealed credential stays. It is the old narrow token, and `mcpConsentAsk`
-- compares the ask against `granted_scopes` (empty here) and forces a fresh
-- consent, so the narrow token is never the one that lists tools again.
--
-- Idempotent: it matches only the old resource, and it refuses to collide with
-- a row that already holds the new one.
WITH retargeted AS (
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
		)
	RETURNING s."id", s."user_id"
)
UPDATE "mcp_connections" AS c
SET
	"status" = 'auth_required',
	"current_catalog_revision_id" = NULL,
	"last_error" = 'Additional permissions require your consent.',
	"updated_at" = now()
FROM retargeted AS r
WHERE c."server_id" = r."id"
	AND c."user_id" = r."user_id";
