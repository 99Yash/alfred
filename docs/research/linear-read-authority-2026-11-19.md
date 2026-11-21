---
status: snapshot
evidence: "Dev catalog revision mcpr_akg1ei9sxj12 (connection mcpc_3lm808w179h2), read 2026-11-19T03:30Z. Prod read-only SQL the same hour. linear.app/docs/mcp and the Linear OAuth metadata documents, fetched the same hour. No write to Linear or to a database."
---

# Linear read authority, 2026-11-19

This file collects the facts about how a Linear MCP read can get read authority in Code Mode.
It does not make a decision. The owner decides.

Each claim has a mark:

- **[F]** is a fact. The mark gives a `file:line`, a SQL result, or a URL.
- **[I]** is an inference. Check it before you build on it.

Terms:

- **Read authority**: a fact that makes `mcpReadFacts` return `read: true` for one tool. Without it, `mcp.read` in a script refuses the call with `not_a_read`.
- **Script route**: the read runs inside `code.run`. The other route is **direct**: the model calls `mcp.call`, and the approval gate applies.

## 1. Summary

1. Linear publishes correct annotations. All 38 tools with `readOnlyHint: true` are reads. No write tool has `readOnlyHint: true`. One read (`whoami`) has `readOnlyHint: false`. [F, section 3]
2. Linear has a read-only resource, `https://mcp.linear.app/mcp/readonly`. Alfred does not use it. This is the same kind of resource that gives GitHub its structural read authority. [F, section 4]
3. Prod has no Linear connection. Only the dev database has one. [F, section 2]
4. Read authority alone does not give the script route. The owner's dev action policy has no `linear` rule, and the default mode is `gated`. A gated read stays direct with a card. [F, section 6]
5. An owner review alone also does not give the script route today. A review records no output kind, so the route is `undeclared_output`. [F, section 6]

## 2. The Linear connection and its grant

### Where the connection is

- Prod has five MCP connections: Polylane, GitHub (`/mcp/readonly`), Sentry, Railway, and Notion. None is Linear. [F: `prodsql.sh "select s.endpoint_url, c.id, c.status, c.granted_scopes from mcp_connections c join mcp_servers s on s.id=c.server_id"`]
- Prod has no `integration_credentials` row with a provider like `linear`. [F: SQL, empty result]
- Dev has one Linear connection: `mcpc_3lm808w179h2`, endpoint `https://mcp.linear.app/mcp`, status `ready`, owner `acBJE0yZFypCyg3AzCOGcvH3MdgZgzZ1`. [F: dev SQL on `mcp_connections`]
- The server identity is `{"serverName": "linear", "serverVersion": "1.0.2", "protocolVersion": "2026-07-28", "toolsListChanged": false}`. [F: `mcp_connections.server_identity`]

### The OAuth grant (no token printed)

- `mcp_connections.granted_scopes` is `["read", "write"]`. `required_scopes` is `[]`. [F: dev SQL]
- `mcp_oauth_credentials.scope` is `read write`. The issuer is `https://mcp.linear.app/`. The token type is `bearer`, with `expires_in` 86100. A refresh token is present. The last authorization was 2026-11-19 03:03:33 UTC. [F: dev SQL. The query read only `is not null` for the sealed columns.]
- The client is a dynamic registration (RFC 7591) named `Alfred`, with `token_endpoint_auth_method: none` and the redirect `http://localhost:3001/api/integrations/mcp/callback`. [F: `mcp_oauth_credentials.client_information`]
- The code asks for `read` and `write` on purpose. [F: `packages/assistant/src/connections/mcp/built-ins.ts:160-161`]
- The authorization server declares `scopes_supported: ["read","write","openid","email"]`. [F: `https://mcp.linear.app/.well-known/oauth-authorization-server`]
- Linear's docs say: "Clients that request `read` are granted read-only access, and the underlying token can't reach write APIs." [F: https://linear.app/docs/mcp]
- So the current token can reach Linear's write APIs. [I, from the two facts above]

### Workspace membership

- No stored row shows the membership. No `chat_messages` row and no `mcp_invocation` row holds a result of `list_users`, `get_workspace`, or `whoami`. The only Linear invocations in dev are 7 calls of `list_issues`. [F: dev SQL]
- The owner states that they are the only member. This file did not check that claim. [F: the task brief]
- The Linear MCP can show it with `list_users` and `get_workspace`. Today each call needs an approval card. This research did not call them. [I]
- To check it in Linear's UI, look at these pages (do not log in for this research):
  - Settings > Administration > Members. This page lists each member and guest.
  - Settings > Account > Security and access > Authorized applications. This page shows the grant that the Alfred client holds, and its access.
  The page names can be different in the current Linear UI. [I]

## 3. The Linear catalog and its annotations

Source: `mcp_catalog_revisions.id = mcpr_akg1ei9sxj12`, revision hash `sha256:99cbcdcee056efcff35da884fe27c46feb332dcc03bb02fe56d8e5738c02217e`, 70 tools, published 2026-11-19 03:03:34 UTC. The values are the annotations as the server declared them (`descriptors[].annotations`). `ro` is `readOnlyHint`, `de` is `destructiveHint`, `id` is `idempotentHint`, and `ow` is `openWorldHint`. [F: dev SQL]

`mcp_tool_policy` has no row for this connection, and no row at all in dev. So every tool has no owner review. No Linear entry is in `BUILT_IN_READ_TOOL_PINS`. `readOnlyCatalog` is `false`. So the current Alfred tier of every Linear tool is `high`, and the effect class is `unknown`. [F: dev SQL `select count(*) from mcp_tool_policy` = 0; `built-in-tool-pins.ts:14-52`; `built-ins.ts:162`; `risk.ts:106-134`; `invocations.ts:136-142`]

### Tools with `readOnlyHint: true` (38)

All 38 have `ro=true, de=false, id=true, ow=false`.

| Tool | What the description says | Output note |
| --- | --- | --- |
| `extract_images` | Fetches the images in Markdown and returns them "as viewable data". | Image content. Binary. [I] |
| `get_agent_skill` | Reads a Linear Agent skill. | |
| `get_attachment` | Reads an attachment. `format=content` (the default) fetches the file. `format=url` gives metadata only. | Can be binary. Depends on the input. [I] |
| `get_diff` | Reads a Linear diff. | |
| `get_diff_threads` | Reads diff threads and the user's drafts. | |
| `get_document` | Reads a document. | |
| `get_issue` | Reads an issue. | |
| `get_issue_status` | Reads an issue status. | |
| `get_milestone` | Reads a milestone. | |
| `get_notifications` | Reads a page of the inbox. | |
| `get_project` | Reads a project. | |
| `get_release` | Reads a release. | |
| `get_release_note` | Reads release notes. | |
| `get_status_updates` | Lists or reads status updates. | |
| `get_team` | Reads a team. | |
| `get_template` | Reads a template. | |
| `get_triage_responsibility` | Reads the triage rotation. | |
| `get_user` | Reads a user profile. | |
| `get_workspace` | Reads the workspace ID, name, and URL. | |
| `list_agent_skills`, `list_comments`, `list_custom_views`, `list_cycles`, `list_diffs`, `list_documents`, `list_issue_labels`, `list_issues`, `list_issue_statuses`, `list_milestones`, `list_project_labels`, `list_projects`, `list_release_notes`, `list_release_pipelines`, `list_releases`, `list_teams`, `list_templates`, `list_users` | Each lists objects. | |
| `search_documentation` | Searches Linear's product docs. | `ow=false`, but the tool reads public docs. The hint is loose, not unsafe. [I] |

### Tools with `readOnlyHint: false` (32)

| Tool | ro | de | id | ow |
| --- | --- | --- | --- | --- |
| `create_attachment`, `create_attachment_from_upload`, `create_issue_label`, `mark_notification`, `prepare_attachment_upload`, `prepare_file_upload` | false | false | false | false |
| `delete_attachment`, `delete_comment`, `delete_status_update`, `restore_issue_label`, `restore_project_label`, `retire_issue_label`, `retire_project_label`, `save_comment`, `save_document`, `save_issue`, `save_issue_label`, `save_milestone`, `save_project`, `save_project_label`, `save_release`, `save_release_note`, `save_status_update`, `share_issue`, `unshare_issue` | false | true | false | false |
| `delete_diff_comment`, `merge_diff`, `save_diff_comment`, `submit_diff_review`, `update_diff` | false | true | false | true |
| `resolve_diff_thread` | false | true | true | true |
| `whoami` | false | false | true | false |

### Check of the annotations against the names and descriptions

- Every `list_*` (18), `get_*` (19), and `search_*` (1) tool has `readOnlyHint: true`. [F: table above]
- No tool that creates, changes, deletes, shares, merges, or marks has `readOnlyHint: true`. [F: table above, compared with each description]
- `get_notifications` has `readOnlyHint: true`. Its description does not say that it marks a notification as read. `mark_notification` is a separate write. [F: descriptions] A read can still change the read state on Linear's side. This research did not test it. [I]
- `whoami` is a read by its description ("Retrieve the authenticated user, the connected workspace, and how this connection reaches Linear"), but it has `readOnlyHint: false`. This error is in the safe direction. It keeps the tool at `high`. [F: descriptor]
- `prepare_attachment_upload` and `prepare_file_upload` have `readOnlyHint: false`. They make a signed upload slot. That is correct. [F: descriptors]
- No tool has an `outputSchema`. Each tool has `_meta: {"microsoft/allowedDomains": ["linear.app<https://linear.app/>"]}`. [F: dev SQL on descriptor keys]

### Descriptor drift in four weeks

The connection has four catalog revisions. The descriptor hash covers the whole tool, so a description edit changes it (`hash.ts:10-12`). [F]

| Revision | Published (UTC) | Tools | Changed descriptors |
| --- | --- | --- | --- |
| `mcpr_3urmw4cjpjte` | 2026-10-24 | 69 | (first) |
| `mcpr_yu3um2qd92se` | 2026-10-29 | 69 | `prepare_file_upload` |
| `mcpr_0w33l48s84j4` | 2026-11-08 | 70 | `list_users`, `list_cycles`, `list_issues`; new tool `whoami` |
| `mcpr_akg1ei9sxj12` | 2026-11-19 | 70 | `save_comment`, `list_documents` |

[F: dev SQL that compares `descriptor_hashes` and `read_only_hints` with `lag()`]

- No `readOnlyHint` value changed for a tool that existed before. `whoami` arrived with `false`. [F]
- Four read descriptors changed in 26 days. [F] A hash pin for each read would have missed four times in that period. [I]

### What Linear and MCP promise about annotations

- Linear's MCP page does not mention `readOnlyHint` or other annotations. [F: https://linear.app/docs/mcp]
- The page says: "Connect to `https://mcp.linear.app/mcp/readonly`, which only ever exposes read tools." [F: https://linear.app/docs/mcp]
- The MCP specification says: "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers." [F: https://modelcontextprotocol.io/specification/2025-11-25/server/tools]

## 4. Linear's read-only resource

- `https://mcp.linear.app/.well-known/oauth-protected-resource/mcp/readonly` returns `{"resource":"https://mcp.linear.app/mcp/readonly","authorization_servers":["https://mcp.linear.app"],"scopes_supported":["read"],...}`. [F: unauthenticated `curl`, 2026-11-19]
- The `/mcp` document returns `"scopes_supported":["read","write"]`. [F: same]
- An unauthenticated `POST` to `/mcp/readonly` returns `401` with `www-authenticate: Bearer realm="OAuth", resource_metadata=".../mcp/readonly", scope="read write"`. The challenge asks for `write` on a read-only resource. [F: `curl -D -`]
- Alfred's consent code adds the demanded scopes only on a step-up (`consent.ts:34-38`). So a `read` pin probably asks only for `read` on the first connect. Test this before you rely on it. [F for the code comment; I for the result]
- This research did not list the tools on `/mcp/readonly`, because that needs a token. It is not known if `whoami` is on it. If `whoami` is on it with `readOnlyHint: false`, Alfred refuses the whole catalog with `write_tool` (`client.ts:1054-1060`). [F for the refusal; I for the risk]

## 5. How a tool gets read authority today

### The code

- `mcpReadFacts` decides read authority for the route. An owner review of the exact descriptor decides alone. Otherwise the tool needs no review under any hash, a published `readOnlyHint`, and one of: a code pin with `effectClass: "read"`, or a built-in read-only endpoint. [F: `packages/assistant/src/tool-runtime/mcp/invocations.ts:158-169`]
- `effectiveMcpRiskTier` sets the tier in this order: the review, a drifted review (`high`), the code pin, the structural branch, the floor. A review and a code pin lower the tier only when the published descriptor asserts `readOnlyHint`. [F: `packages/assistant/src/tool-runtime/mcp/risk.ts:106-134`]
- `mcpToolEffectClass` uses the same order for the effect class. [F: `invocations.ts:136-142`]
- `decideReadRoute` sends a call to a script only for a confirmed read with a `structured` output and no approval. [F: `packages/assistant/src/tool-runtime/read-route.ts:38-48`]
- The output kind comes from the code pin, or `structured` for a read-only built-in endpoint. Otherwise it is `undefined`. [F: `packages/assistant/src/connections/mcp/built-in-tool-policy.ts:86-96`]
- Approval is needed when the mode is `gated` or the tier is `high`. [F: `packages/assistant/src/tool-runtime/approval-rule.ts:18-20`]

### The GitHub structural branch

- The GitHub endpoint is `https://api.githubcopilot.com/mcp/readonly`. [F: `packages/assistant/src/connections/mcp/constants.ts:10`]
- The GitHub registry entry sets `readOnlyCatalog: true`. [F: `built-ins.ts:151`]
- `builtInReadOnlyResource` returns that flag for the stored endpoint URL. It does not use `canonical_resource`. [F: `built-ins.ts:277-280`; `invocations.ts:326-327`]
- On each catalog refresh, the client refuses the whole catalog if one tool does not assert `readOnlyHint: true`. [F: `packages/assistant/src/connections/mcp/client.ts:1054-1060`]
- Publication derives `read_only_hints` from the descriptors. No caller can supply the map. [F: `packages/assistant/src/connections/mcp/hash.ts:23-33`]
- The gate then needs both facts: the pinned read-only endpoint and the stored hint of the tool. [F: `risk.ts:130-131`]

### The ADRs

- **ADR-0094.** Read-only is a property of the resource that Alfred connects to. It is not a tool allow-list. A read-only built-in refuses a catalog with a tool that lacks `readOnlyHint` (amendment 2026-09-03). ADR-0094 rejects a filter of `/mcp` to its read tools, because a new tool is admitted by default. [F: `docs/decisions/ADR-0094-mcp-read-only-surface-is-a-pinned-resource.md:3, 33-36, 59`]
- **ADR-0096.** The structural branch: a built-in read-only resource and the tool's published `readOnlyHint` give `low` with no review. An owner review wins in both directions. A tool that the owner ever reviewed never takes the structural branch. ADR-0096 rejects the owner review as the only mechanism, because it makes the owner the read/write classifier for each descriptor. [F: `docs/decisions/ADR-0096-a-read-only-mcp-surface-downgrades-structurally.md:3-10, 24-28`]
- **ADR-0096 amendment 2026-11-13.** The Google servers are read-write, so they get code-owned pins. Each pin binds one tool to one descriptor hash. "The owner rejected two weaker rules: `readOnlyHint` alone, and a name pin plus the hint." A drift sends the tool back to `high`. The drift script lists the drift. "Nothing runs the drift script on a schedule." [F: same file, lines 74-86]
- **ADR-0096 amendment 2026-11-18.** The structural branch has the `read` effect class. [F: same file, lines 88-94]
- **ADR-0124 amendment 2026-11-18.** "Read authority is independent of the server." A confirmed read needs a trusted built-in read-only endpoint with the published hint, or an exact read policy bound to the descriptor, from Alfred's code or approved by the owner. "The hint of a custom server alone leaves the effect unknown." The output kind is declared beside the read authority. [F: `docs/decisions/ADR-0124-code-mode-is-the-chat-read-path.md:44-51`]
- **ADR-0124 amendment 2026-11-18 (b).** "Gated reads stay direct." [F: same file, line 70]

## 6. Two conditions apart from read authority

### The action policy mode

- The dev owner's `user_action_policies` row has `default_mode = gated` and no `linear` rule. [F: dev SQL on `user_action_policies`]
- A missing rule falls back to the default mode, and the default of a new row is `gated`. [F: `packages/assistant/src/action-policies/resolve.ts:34-39`]
- So a Linear read with read authority still needs approval and stays direct, until the owner sets Linear to Auto (`autonomy`). [I, from the facts above and `approval-rule.ts:18-20`]

### The output kind

- `mcp_tool_policy` has no output kind column. [F: `packages/db/src/schema/mcp.ts:277-298`]
- The review form sends only `riskTier`, `effectClass`, `retryContract`, and `note`. [F: `packages/http/src/mcp.ts:643-654`; `apps/web/src/routes/-integrations/mcp-tool-policy.tsx:24-38`]
- For a Linear tool, `builtInOutputKind` returns `undefined`. [F: `built-in-tool-policy.ts:86-96`]
- So a reviewed Linear read gets `undeclared_output` and stays direct. [I, from `read-route.ts:43`]

## 7. Options for Linear read authority

### (a) Code pins for the Linear reads

What it is: add a `linear` block to `BUILT_IN_READ_TOOL_PINS`, with one descriptor hash for each read.

What already exists:

- The pin table and the policy entry accept any built-in provider. [F: `built-in-tool-pins.ts:10-12`; `built-in-tool-policy.ts:60-78`]
- A pin gives `low`, `read`, and `structured`. A per-provider list marks a binary read. [F: `built-in-tool-policy.ts:34-48`]
- The gate needs both the pin and the published `readOnlyHint`. [F: `risk.ts:126-128`]
- This is the decided mechanism for a read-write built-in (Google). [F: ADR-0096 amendment 2026-11-13]

What is missing:

- The drift script reads only the Google servers, with the Google credential. It needs a Linear path, for example from the stored current revision. [F: `packages/assistant/src/connections/mcp/built-in-policy-drift.ts:18-24`]
- `extract_images` and `get_attachment` need a binary mark or no pin. [I]

Risk:

- Four read descriptors drifted in 26 days. Each drift sends the read back to `high` and to a card until a new pin ships in a deploy. [F for the drift count; I for the cost]
- The pin approves an exact interface. The behavior of the server stays a trust assumption. [F: ADR-0124:49]
- This choice fails closed. [F: ADR-0096 amendment 2026-11-13, "Fail closed"]

### (b) Trust the server's `readOnlyHint`, with a drift check

What it is: for the Linear built-in, take `readOnlyHint: true` as read authority. Check the hints when a new catalog revision arrives.

What already exists:

- Each revision stores `read_only_hints`, derived at publication. [F: `hash.ts:23-33`; `packages/db/src/schema/mcp.ts:80-84`]
- The revisions are append-only, so a check can compare a new revision with the last one. [F: `packages/db/src/schema/mcp.ts:58`]

What is missing:

- A registry flag or rule that trusts the hint of one read-write built-in. No such rule exists. [F: `invocations.ts:158-169`]
- A check that refuses or flags a change from `false` to `true`. No such check exists. [I]

Risk:

- The owner rejected "`readOnlyHint` alone" for the Google built-ins on 2026-11-13. This option needs a new decision that reverses or limits that rejection. [F: ADR-0096:76]
- The MCP specification calls annotations untrusted unless the server is trusted. [F: MCP spec URL above]
- A server error that puts `readOnlyHint: true` on a write gives a write with no card. Today Linear's hints are correct (section 3). [F for today; I for the future]
- A new Linear read tool gets authority at once, with no review. [I]

### (c) The owner confirms each read in a UI

What it is: the owner reviews each Linear read in the MCP review form and sets `effectClass: read` and a tier below `high`.

What already exists:

- A `PUT /connections/:id/tools/policy` route and a review form in the MCP catalog page. [F: `packages/http/src/mcp.ts:643-654`; `apps/web/src/routes/-integrations/mcp-connection-catalog.tsx:386-396`]
- A review binds to the exact descriptor hash, wins in both directions, and holds through a drift as `high`. [F: ADR-0096:7-8; `invocations.ts:158-169`]
- A review lowers the tier only when the tool asserts `readOnlyHint`. So the review cannot lower `whoami`. [F: `risk.ts:115-116`]

What is missing:

- An output kind in the review. Without it, every reviewed Linear read stays direct with `undeclared_output`. [F: section 6]

Risk:

- ADR-0096 rejects this as the only mechanism: the owner becomes the classifier for each descriptor. [F: ADR-0096:28, 56]
- 38 reads need 38 reviews. Each drift needs a new review, and four drifts happened in 26 days. [F for the counts; I for the cost]

### (d) Connect Linear's read-only resource (found in this research)

What it is: a second Linear built-in on `https://mcp.linear.app/mcp/readonly`, with `scopes: ["read"]` and `readOnlyCatalog: true`. The current `/mcp` built-in keeps the writes.

What already exists:

- The whole GitHub path: the registry flag, the catalog refusal, the structural tier, the `read` effect class, and the `structured` output. [F: section 5]
- ADR-0093 says a built-in key names a server, not a product. So two Linear keys follow the rule. [F: `decisions.md:58`]
- Linear documents the resource and its `read`-only scope. [F: https://linear.app/docs/mcp; the protected-resource document]

What is missing:

- A new key in the contracts catalog and the registry, a second OAuth grant, and a connect flow for it. [I]
- A rule for the same read on two connections. The model can see `list_issues` on both. ADR-0124 decision 1 asks for one read path. [I; F for decision 1 at ADR-0124:17]

Risk:

- If the read-only catalog has a tool with no `readOnlyHint: true`, such as `whoami`, every refresh fails with `write_tool`. Read `tools/list` on that resource before you decide. [I]
- The `401` challenge asks for `scope="read write"`. Check that the consent ask stays at `read`. [F for the header; I for the effect]
- A new read tool that Linear adds is admitted with no review. Linear's resource, not Alfred, keeps the writes out. That is the same trust that GitHub gets. [I, from ADR-0094:3]

### Comparison

| Option | Fits a settled ADR | Code to add | Cost of a drift | Gives the script route |
| --- | --- | --- | --- | --- |
| (a) Code pins | Yes (ADR-0096 amendment 2026-11-13) | Pins, a binary list, a Linear drift path | A card until a deploy | Yes, if the Linear mode is Auto |
| (b) Trust the hint | No. The owner rejected it on 2026-11-13. | A trust rule and a hint-change check | None | Yes, if the Linear mode is Auto |
| (c) Owner review | Yes, but not as the only mechanism | An output kind in the review | A new review | No, until the output kind exists |
| (d) Read-only resource | Yes (ADR-0094, ADR-0096) | A second built-in and grant | None. A refusal if a hint is missing. | Yes, if the Linear mode is Auto |

All four options need the Linear rule set to Auto for the script route. [I, from section 6]

## 8. Open questions for the owner

1. Do you want the `/mcp/readonly` resource tested with a `read`-only grant? The test reads `tools/list` and changes nothing.
2. Do you accept two Linear connections (read and write), or one connection with code pins?
3. Do you want Linear on Auto? Without it, no option gives the script route.

## 9. Probe result 2026-11-21

The probe used two temporary OAuth clients with the owner's consent. They read only (`tools/list`, `list_teams`) and wrote nothing to Linear. The probe did not print or store a token. The raw results are in `references/scratch/1804-linear-readonly-probe-result.json` and `references/scratch/1804-linear-rw-probe-result.json` (not tracked).

- A grant with the ask `read` and the resource `/mcp/readonly` got the scope `read`. [F]
- `/mcp/readonly` lists 38 tools. Each one has `readOnlyHint: true`. `whoami` is not on the list. [F] So the ADR-0094 rule does not refuse this catalog. [I]
- The 401 challenge of `/mcp/readonly` asks for `scope="read write"`, but the consent with the ask `read` granted only `read`. [F]
- The `read` token gets `401 invalid_token` on `/mcp`. [F]
- A grant with the ask `read write` and the resource `/mcp` (Alfred's grant today) opens both endpoints: 70 tools on `/mcp` and 38 on `/mcp/readonly`. `list_teams` works on both. [F]

This closes open question 1 of section 8. The owner's answers to the design questions are in ADR-0130 amendment (h).
