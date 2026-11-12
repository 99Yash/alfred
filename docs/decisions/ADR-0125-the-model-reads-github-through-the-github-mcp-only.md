# ADR-0125 — The model reads GitHub through the GitHub MCP only; the GitHub App stays for the MCP login and the webhooks

**Status.** Accepted; built. Decided with the owner on 2026-11-12. Amends ADR-0052: the App installation token no longer serves a model tool. Amends ADR-0071 and ADR-0068: the structured GitHub search fields go with the tool that had them. Amends ADR-0074: GitHub leaves the passthrough tier. Builds on the ADR-0093 amendment of 2026-11-12 (the GitHub MCP uses the App client) and on ADR-0094 (the read-only resource).

**Decision in one paragraph.** Alfred has no curated GitHub tool and no GitHub passthrough. The six `github.*` tools (`search`, `get_pull_request`, `get_pull_requests`, `get_issue`, `get_issues`, `request`) are deleted. The GitHub MCP built-in, pinned to the read-only resource `/mcp/readonly` (ADR-0094), is the only surface through which the model reads GitHub. The GitHub App stays. It is the OAuth client for the MCP login, and it is the webhook source for ingress and for the activity record. Background code that reads GitHub over REST keeps the App installation token. A connect writes no GitHub token to the GitHub credential row.

## Why

- **One read surface.** With two GitHub surfaces, the model had to choose between `github.search` and the MCP search for the same question. Principle 7 asks for the fewest parts, and ADR-0124 asks for one read path.
- **The provider rule already says so.** The ADR-0093 amendment of 2026-10-23 (#1008) says that a provider with a working MCP server connects only through that server, and that background code may keep a REST call on the same credential. Notion and Sentry follow it. GitHub was the exception, because its MCP needed its own OAuth App. Since 2026-11-12 the MCP uses the App client, so the exception has no reason.
- **The MCP catalog is wider.** The read-only resource lists 28 read tools (ADR-0094 amendment, 2026-11-12). The curated tools covered issues and pull requests. The passthrough covered the rest, but it was off by default.

## The decisions

1. **The `github` registry entry keeps its credential and its ingest route.** `INTEGRATIONS.github` keeps `credential: { shape: "github_app" }` and `sourceRoutes: ["ingest"]`. It has `actions: []` and `passthrough: null`. Thus `github` is not a `SupportedPassthroughSlug`, and the passthrough settings page has no GitHub row.
2. **The model finds the GitHub tools as MCP tools.** The connected summary has one line for each MCP connection, with its label and its tool count. `system.search_tools` and `mcp.list_tools` find a GitHub tool, and `mcp.call` calls it. The read-only built-in lowers the `mcp.call` approval floor (ADR-0096), so a GitHub read shows no approval card.
3. **The App stays for two jobs.** It is the OAuth client of the GitHub MCP login (ADR-0093 amendment, 2026-11-12). It is the webhook source for ingress (ADR-0097) and for the activity record (ADR-0118).
4. **Background REST reads keep the installation token.** The loop verifier reads a pull request over REST with an installation token (ADR-0120, ADR-0062 amendment of 2026-11-06). The REST client keeps that read only (`getPullRequests`). The briefing's merged read already uses the MCP (ADR-0062 amendment of 2026-10-27).
5. **A connect writes no GitHub token to the credential row.** The MCP connection holds the App user grant. `upsertGithubCredential` writes the placeholder `ghu_placeholder_<installation id>` and `expiresAt: null`, because `access_token` is NOT NULL. `getGithubAccessToken` is deleted. No migration: an old row keeps its sealed access token until the next connect writes the placeholder. Migration 0167 already cleared the old refresh tokens, so Alfred cannot renew that token. The token is not always expired. A token issued less than eight hours before the deploy still works, and an App with token expiry turned off issues user tokens that do not expire. No code reads the old token, so the risk is a stored secret, not a read path. Check the "Expire user authorization tokens" setting of the production App before you rely on expiry.

## The trade-off

- **Reach is not the same as before.** The deleted tools used one installation token, so they reached the repos of the one installation that Alfred selected, with the App permissions. The MCP uses an App user token. It reaches a repo only when both the user and an installation of the App can reach it, and it can cover more than one installation (ADR-0093 amendment, item 4). So the MCP can reach more repos than the deleted tools (other installations) or fewer (a repo that the installation has but the user cannot see). The same App client does not give the same access. Check the installations of the production App before you compare the two. The old OAuth App reached every repo that the user can see.
- **The App permissions limit the catalog.** GitHub hides a tool that the token cannot reach (ADR-0094, "The forced trade"). If the production App lacks a permission that the dev App has, the catalog is smaller. Nothing checks the tool count (ADR-0094 amendment, 2026-11-12).
- **No GitHub reads without the MCP connection.** Before, the curated tools worked with the App credential alone. Now, a GitHub MCP connection in `auth_required` leaves the model with no GitHub read. The connected summary then tells the model to ask the user to reconnect.
- **The structured search fields are gone.** `github.search` resolved a time window in the user's timezone on the server (ADR-0068), and it folded free-typed qualifiers into fields (ADR-0071). Those fields stopped the silent-zero trap of #213: the model wrote a different free-form query for the same question, and the counts changed (19 vs 23). The MCP search takes GitHub search syntax as written by the model, so that failure can occur again.
- **The login is not in the summary.** The GitHub line said "connected as <login>", so the model could resolve `@me`. The MCP catalog has `get_me`, and GitHub search accepts `@me`.
- **No batch read with diff totals.** `github.get_pull_requests` summed the diff stats of many pull requests in one call. It stopped the N+1 loop of #935, where the model called `github.get_pull_request` one time for each pull request. With the MCP, the model can do the same loop with `pull_request_read`. ADR-0124 (Code Mode) is the answer to fan-out for every read tool.

## Alternatives

- **(a) Keep the REST tools beside the MCP.** Rejected. It keeps two read paths for one provider.
- **(b) Keep only the `github.request` passthrough, for what the MCP does not have.** Rejected by the owner. A read that the MCP catalog does not have is a gap to report, not a reason for a second path.
- **(c) Move the loop verifier read to the MCP now.** Deferred. The probe of 2026-10-27 found no output schema on `pull_request_read`, and a large body clips its result (ADR-0062 amendment of 2026-10-27). The current upstream source of the GitHub MCP server declares an output schema for this tool, so read the hosted descriptor again before a move. The REST read returns the GitHub id that the store needs.

## Residual risk

- No test and no gate proves that the model sees the GitHub MCP tools. The proof is the connected summary line, the MCP search, and a connected MCP row. Migration 0167 forces one reconnect of the GitHub MCP.
- The evals changed. `github-grounding` and `passthrough-honesty` are deleted, because they graded the deleted tools. The nightly workflow no longer runs them, and no GitHub eval runs on the schedule. The `boss-judgment` GitHub sub-agent case now expects `mcp.call` with the connection, the catalog revision, and the arguments that production needs. It uses a mock, not the real discovery and dispatch path. No eval grades the ADR-0074 honesty of the Google and Vercel passthrough now.
- A stored transcript or a checkpoint can name a deleted tool. `migrateActiveTools` drops a retired name, and the chat page shows a retired name with a generic title. A run that calls a deleted tool gets an `unknown_tool` result that points it at `system.search_tools`.
- `feature.passthrough.github` preference rows stay in the database. No code reads them.

## Cross-ref

Amends ADR-0052, ADR-0068, ADR-0071, and ADR-0074. Builds on ADR-0093 (amendments of 2026-10-23 and 2026-11-12), ADR-0094, and ADR-0096. Keeps ADR-0097, ADR-0118, and ADR-0120 as they are. Theory: [docs/theory/README.md](../theory/README.md).
