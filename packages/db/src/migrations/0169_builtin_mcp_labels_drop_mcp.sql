-- The built-in MCP labels drop "MCP" (owner rule, 2026-11-12): "GitHub MCP" becomes "GitHub".
-- `ensureBuiltInConnection` copies the catalog label into the row, but only when it runs, so
-- the rows that exist now keep the old label until this update.
--
-- A row changes only while it is on the built-in's server and still holds the old catalog
-- label. Any other label stays. Idempotent: a second run finds no old label.
-- Accepted limit: no column records who set a label, so an owner's "GitHub MCP" also changes.
UPDATE "mcp_connections" c
SET
	"label" = v."new_label",
	"updated_at" = now()
FROM "mcp_servers" s,
	(VALUES
		('https://api.githubcopilot.com/mcp/readonly', 'GitHub MCP', 'GitHub'),
		('https://mcp.linear.app/mcp', 'Linear MCP', 'Linear'),
		('https://mcp.notion.com/mcp', 'Notion MCP', 'Notion'),
		('https://mcp.sentry.dev/mcp', 'Sentry MCP', 'Sentry'),
		('https://mcp.railway.com/mcp', 'Railway MCP', 'Railway'),
		('https://mcp.polylane.com/mcp', 'Polylane MCP', 'Polylane'),
		('https://mcp.clickup.com/mcp', 'ClickUp MCP', 'ClickUp')
	) AS v("canonical_resource", "old_label", "new_label")
WHERE s."id" = c."server_id"
	AND s."canonical_resource" = v."canonical_resource"
	AND c."label" = v."old_label";
