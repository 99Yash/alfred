---
status: snapshot
evidence: "Production catalog revision mcpr_ewiezcunvuvp, read 2026-10-23. Live append probe the same day."
---

# Notion MCP catalog, 2026-10-23

This is the catalog that Notion's hosted MCP server (`https://mcp.notion.com/mcp`) gave to
Alfred's production connection on 2026-10-23. It is the input to #1008 (Notion half): the
decision to connect Notion only through MCP and to delete the curated `notion.*` tools.

- Revision: `sha256:98a3157fff934ed283a394e0c75312555cb17953036a975faf31659a602611db`
  (`mcp_catalog_revisions.id = mcpr_ewiezcunvuvp`), 65 tools, 36 with `readOnlyHint: true`.
- Source of truth: `mcp_catalog_revisions.descriptors` for that row. This file is a summary.
  The table keeps the first sentence of each description and the `required` arguments only.
- Notion's public tool page (`developers.notion.com/docs/mcp-supported-tools`) does not list
  the `insert_content` command of `notion-update-page`. Only the live schema has it. Read the
  stored catalog, not the docs, before you decide parity.

## Curated tool to MCP tool

| Curated tool (deleted) | MCP tool | Note |
| --- | --- | --- |
| `notion.search` | `notion-search` | |
| `notion.get_page` | `notion-fetch` | Returns Notion-flavored Markdown, not top-level blocks only. |
| `notion.create_page` | `notion-create-pages` | Parent is optional; no parent makes a private page. |
| `notion.append_blocks` | `notion-update-page` with `command: "insert_content"` | `position` `{"type":"end"}` or omitted appends; `{"type":"start"}` prepends. |
| `notion.request` (database schema, block children, search, database query) | `notion-fetch`, `notion-query-data-sources`, `notion-search` | `notion-fetch` reads a database or data source schema. |

## Append probe

Run on production on 2026-10-23 through `McpConnectionManager.prepareToolCall` on the Notion
connection. The script was a one-off and is deleted.

1. `notion-create-pages` made a page with the content `line one (from create)`.
2. `notion-update-page`, `command: "insert_content"`, no `position`, content `line two`.
3. `notion-update-page`, `command: "insert_content"`, `position: {"type":"end"}`, content `line three`.
4. `notion-fetch` returned the three lines in that order. No content was replaced.
5. `notion-delete-pages` with `user_confirmed: true` moved the page to Trash.

All five calls returned `outcome: completed`.

## Tools

| Tool | Read-only hint | Required arguments | Description (first sentence) |
| --- | --- | --- | --- |
| `notion-calendar-cancel-events` | no | `events` | Cancel one or more identified events the user can manage. |
| `notion-calendar-create-events` | no | `timeZone`, `events` | Create one or more events on writable calendars. |
| `notion-calendar-list-calendar-resources` | yes | `timeSlots`, `minCapacity`, `timeZone` | List rooms or other calendar resources available for specific times. |
| `notion-calendar-list-calendars` | yes | none | List calendars grouped by connected account. |
| `notion-calendar-list-contacts` | yes | none | Find contacts by name or email across the user's connected Calendar accounts. |
| `notion-calendar-list-coworkers-events` | yes | `coworkerEmails`, `timeMin`, `timeMax`, `timeZone` | List detailed events for coworkers in the same organization within a time range. |
| `notion-calendar-list-events` | yes | `timeMin`, `timeMax`, `timeZone` | List the user's events across connected calendars within a time range. |
| `notion-calendar-update-events` | no | `timeZone`, `updates` | Update one or more identified events, including timing, attendees, recurrence, resources, or RSVP status. |
| `notion-check-mcp-next-steps` | yes | none | When to call: Only when a Notion fetch result instructs you to. |
| `notion-convert-page-to-skill` | no | `page_url` | Mark an existing Notion page as a skill without changing its content. |
| `notion-create-attachment` | no | none | Create an attachment and upload it to Notion. |
| `notion-create-comment` | no | `page_id` | Add a comment to a page or specific content. |
| `notion-create-database` | no | none | Creates a new Notion database using SQL DDL syntax, or a canonical typed database for tasks, projects, or skills. |
| `notion-create-file-upload` | no | `filename` | Create a short-lived URL for uploading one local file directly to Notion. |
| `notion-create-folder` | no | `parent`, `title` | Creates an empty Notion Folder. |
| `notion-create-pages` | no | `pages` | Creates one or more Notion pages with the specified properties and content. |
| `notion-create-view` | no | `data_source_id`, `name`, `type` | Create a new view on a Notion database. |
| `notion-delete-comment` | no | `comment_id` | Delete a comment you wrote. |
| `notion-delete-databases` | no | `database_ids` | Move Notion databases to Trash. |
| `notion-delete-pages` | no | `page_ids` | Move Notion pages to Trash. |
| `notion-download-attachment` | yes | `file_upload_id` | Download the contents of a small UTF-8 text attachment created by the Notion MCP `create-attachment` tool. |
| `notion-download-skill` | yes | `id` | Download a spec-compliant Notion Skill as a complete tar.gz archive containing SKILL.md and its supporting files and nested folders. |
| `notion-duplicate-page` | no | `page_id` | Duplicate a Notion page. |
| `notion-fetch` | yes | `id` | Retrieves details about a Notion entity (page, database, data source, or saved database view) by URL or ID. |
| `notion-get-async-task` | yes | `task_id` | Retrieves the current status of an async task that was started by another tool (for example, "create_pages" called with "allow_async": true). |
| `notion-get-comments` | yes | `page_id` | Get comments and discussions from a Notion page. |
| `notion-get-enabled-skills` | yes | none | Use this tool to view the Notion skills the user has enabled for you and other external MCP clients, each with a name and a description of when it should be... |
| `notion-get-file-download-urls` | yes | `references` | Get signed download URLs for files that fetch output cites by stable `notion-file-block://` references. |
| `notion-get-groups` | yes | none | Retrieves permission groups in the current workspace that you can see, with their IDs and names. |
| `notion-get-self` | yes | none | Get the current Notion connection's workspace and authenticated user. |
| `notion-get-session-status` | yes | `session_url` | Get the latest turn's status for a Custom Agent session without waiting. |
| `notion-get-teams` | yes | none | Retrieves a list of teams (teamspaces) in the current workspace. |
| `notion-get-tool-access` | yes | none | Get current tool availability, parameter restrictions, and available upgrade links for this Notion connection. |
| `notion-get-users` | yes | none | Retrieves a list of users in the current workspace. |
| `notion-list-favorite-pages` | yes | none | List the current user's favorite pages and databases in sidebar order. |
| `notion-list-page-backlinks` | yes | `page_id` | List the pages that link to or mention a Notion page (backlinks), in the same workspace. |
| `notion-list-private-pages` | yes | none | List the current user's top-level pages and databases in their Private sidebar section. |
| `notion-list-recent-pages` | yes | none | List pages and databases the current user recently viewed, ranked by recency and visit frequency. |
| `notion-list-session-events` | yes | `session_url`, `count` | List short summaries of saved events in a Custom Agent session. |
| `notion-list-shared-pages` | yes | none | List pages and databases in the current user's Shared sidebar section. |
| `notion-memory-search` | yes | `query` | Search memories that the user's connected agents saved in earlier sessions: context, preferences, corrections, and decisions. |
| `notion-move-pages` | no | `page_or_database_ids`, `new_parent` | Move one or more Notion pages or databases to a new parent. |
| `notion-query-data-sources` | yes | `data` | Query Notion data sources using faithful structured rows, SQL, or a saved view. |
| `notion-query-meeting-notes` | yes | none | Query the current user's meeting notes data source. |
| `notion-query-multiple-data-sources` | yes | `query`, `data_source_urls` | Query data across multiple Notion data sources using read-only SQLite SQL. |
| `notion-query-sessions` | yes | none | List agent sessions available to the integration. |
| `notion-read-session-event` | yes | `session_url`, `sequence` | Read the full visible content of one saved Custom Agent session event. |
| `notion-restore-pages` | no | `page_ids` | Restore Notion pages or databases from Trash to where they were before they were deleted. |
| `notion-search` | yes | `query` | Search Notion pages and databases, or look up a user by name or email. |
| `notion-search-agents` | yes | `scope` | Search agents by name or description, or browse the current user's favorite agents and the workspace's newest agents. |
| `notion-search-sessions` | yes | `question` | Search past agent sessions by topic in a periodically refreshed index and return matching session URLs and excerpts. |
| `notion-send-message-to-session` | no | `session_url`, `message` | Send a follow-up message to a Custom Agent session you can access. |
| `notion-set-comment-reaction` | no | `comment_id`, `emoji`, `reacted` | Add or remove your emoji reaction on a comment. |
| `notion-set-discussion-resolved` | no | `discussion_id`, `resolved` | Resolve or reopen a comment discussion. |
| `notion-show-advanced-analysis-next-steps` | yes | none | Use this exactly once at the end of a turn when query_multiple_data_sources requires the full version of Notion MCP. |
| `notion-spawn-session` | no | `agent_url`, `initial_message` | Start a session with a published Custom Agent. |
| `notion-stop-session` | no | `session_url` | Stop a running Custom Agent session you can access. |
| `notion-update-comment` | no | `comment_id`, `markdown` | Replace the text of a comment you wrote. |
| `notion-update-data-source` | no | `data_source_id` | Update a Notion data source's schema, title, attributes, or page layout. |
| `notion-update-enabled-skills` | no | none | Enable Notion Skills for the current user, or turn them off for external MCP clients, Notion AI, or both. |
| `notion-update-folder` | no | `folder_id`, `command` | Update an existing Notion Folder with an explicit Folder operation. |
| `notion-update-page` | no | `page_id`, `command` | Update a Notion page's properties, content, icon, or cover. |
| `notion-update-view` | no | `view_id` | Update a view's name, filters, sorts, or display configuration. |
| `notion-upload-skill` | no | `action`, `page_id` | Import a spec-compliant Agent Skills directory into a page in a Skills database. |
| `notion-wait-session` | yes | `session_url`, `seconds` | Wait for the latest turn in a Custom Agent session to stop running. |
