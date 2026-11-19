# Read sensitivity classes: `metadata` and `private_content`

Date: 2026-11-19. Commit: `38c84270c`. Status: research for the owner. No code changed.

**Markers.** **[F]** is a fact with a receipt (file:line, SQL, or URL). **[I]** is an inference. An unmarked sentence is a proposal.

**The decision that this page serves (owner, 2026-11-19; not open here).** Approval shape C. Each read declares a sensitivity: `metadata` or `private_content`. Under the `gated` policy mode, a confirmed read with `metadata` runs with no approval card. A `private_content` read and an undeclared read still ask. A `high` tier always asks. Full Autonomy waives all cards. The owner rule: "non-destructive and non-secretive reads can run on their own." A second owner rule: when a policy or a setting blocks the agent from a task that the user asked for, the agent tells the user which setting the user can change.

---

## 0. The gate today

- [F] The rule is one function: `policyMode === "gated" || riskTier === "high"` (`packages/assistant/src/tool-runtime/approval-rule.ts:18-20`). `callRequiresApproval` adds the staging arm and Full Autonomy (`approval-rule.ts:28-41`). `fast_path` and `join` return before the gate (`internal/dispatch/staging-arm.ts`, `fast_path: null`).
- [F] There are two policy modes, `autonomy` and `gated` (`packages/contracts/src/tools.ts:11`). The tiers are `no_risk`, `low`, `medium`, `high` (`tools.ts:79`).
- [F] Resolution order: `system.*` returns `autonomy` before the row is read. Then the tool override, then the integration mode, then the user default (`packages/assistant/src/action-policies/resolve.ts:108-124`). A built-in `mcp.call` reads the rule of its provider, and the tool overrides of `mcp` do not apply then (`resolve.ts:119-121`).
- [F] `mcp.call` starts at `high`. A review row, a code pin, or the read-only built-in resource can lower it to `low` (`tool-runtime/mcp/risk.ts:19,25,106-134`). Each lowering also needs the published `readOnlyHint` (`risk.ts:116,127,131`).
- [F] The read route sends a confirmed read with structured output and no card to a script. A read that needs a card stays direct (`tool-runtime/read-route.ts:38-48`).
- [F] CONTEXT.md:45 says "`gated` gates reads too — there is no read/write split". ADR-0034 line 13 says "The dispatcher never reads `riskTier` for gating decisions." ADR-0069 already broke that second sentence with the `high` floor.
- [F] Production policy: `default_mode = gated`, and the only rule is `{"system":{"mode":"autonomy"}}`. 2 of 20 chat threads have Full Autonomy on. SQL: `select default_mode, integration_rules from user_action_policies`; `select count(*) filter (where full_autonomy), count(*) from chat_threads` (via `references/scratch/prodsql.sh`).
- [F] In the last 30 days, production staged 9 approval cards for `mcp.call` reads at `low` (all GitHub: `search_pull_requests`, `get_me`, `search_repositories`, `list_issues`, `search_issues`). The user rejected none. 8 executed and 1 failed. SQL: `select display_input->>'remoteName', status from action_stagings where requires_approval and tool_name='mcp.call' and risk_tier='low' and created_at > now() - interval '30 days'`.
- [F] Those rows store `integration = 'mcp'`, not `github` (same table, `group by integration`). The card thus names the wrong integration for a GitHub read. See section 5.

---

## 1. The threat model of a read

A read changes nothing outside Alfred. So the question is: what can go wrong when the result enters the model context? Four candidates follow.

### T1. Private content goes to the model provider and the AI gateway — holds, but weaker than it looks

- [F] The privacy boundary as built: "The model providers and the AI gateway see the content of each model call" (`docs/theory/README.md`, section 1). The owner accepts this boundary.
- [F] Background code already sends mail bodies to the provider with no card. Triage puts the full mail body in the prompt (`packages/assistant/src/triage/classify.ts:441` at `HEAD`).
- [F] Two `system.*` reads return private content with no card in any mode, because `system.*` never gates (`resolve.ts:115`). `system.corpus_search` returns passages of ingested mail and attachments (`internal/tools/corpus.ts:21-28`). `system.search_context` returns snippets of memory, ingested documents, and live Drive files (`internal/tools/context-search.ts:17-27`).
- [I] Thus a card on `gmail.get_message` does not keep mail away from the provider. The card protects provider exposure only for content that Alfred does not already send: full Drive files, sheet values, private source code, and secrets.
- Verdict: T1 holds. It is a consent check on a disclosure, not a hard barrier.

### T2. Prompt injection from fetched third-party text — does not hold as stated; holds as exfiltration

- [I] The card comes before the read, so the card cannot see the text. A card on a read thus does not stop an injection.
- [F] The control against an injected write is the write gate: `gated` mode and the `high` floor (ADR-0069).
- [F] An outbound channel with no card exists: `system.fetch_url` and `system.web_search` are `system.*` reads, so they never gate (`internal/tools/system.ts:733,758`; `resolve.ts:115`). A URL or a query can carry data out.
- [I] Exfiltration needs three parts in one turn: untrusted text, access to private content, and an outbound channel. The channel is open. Under `gated`, the card on a content read is the one control that removes the second part.
- [I] The ungated `system.corpus_search` and `system.search_context` (T1) already open the second part for ingested data. So this protection is real only for content that those two reads do not reach.
- Verdict: T2 holds as "a content read gives an injected instruction something to send out". It does not hold as "the card stops an injection".

### T3. Credentials or secrets enter the context — holds, strongly

- [I] A secret in a result goes to the provider. It is stored in the chat messages, in the staging row result, and in the traces. An injected instruction can also send it out through the channel of T2. Unlike mail, a secret is not already in Alfred's stores.
- [F] Reads that can return a secret exist or can get read authority: `vercel.request` takes any GET path, with no path filter (`internal/tools/vercel.ts:76-96`; no `env` or `decrypt` filter in `packages/integrations/src/shared/rest-passthrough.ts`). Railway publishes `list-variables` and `get-bucket-credentials` with `readOnlyHint: true` (production `mcp_catalog_revisions.read_only_hints`, SQL in section 3).
- Verdict: T3 holds. This is the "secretive" half of the owner rule.

### T4. Other people's private data that the owner can access — holds, as a reason inside T1 and T2

- [I] Mail from other people, shared Drive files, events of coworkers, issues in an organization repository, and error events with the personal data of end users all have authors who did not agree to send their words to a model provider. The owner has access. The authors did not consent to the next step.
- Verdict: T4 holds. It is not a separate class. It is the reason why "what an item says" weighs more than "that an item exists".

### What does not count

- A destructive effect. The read route already requires a confirmed read (`read-route.ts:39`). A call with an unconfirmed effect stays `high` (`risk.ts:106-133`). The sensitivity class does not decide effect.
- Cost, rate limits, and latency. These are not reasons for a card.

---

## 2. The principle

**Definitions.**

- An *item* is one thing in a connected account: a mail, a file, an event, an issue, a record, a variable.
- The *description* of an item is the data that identifies it, places it in time, names its parties, gives its state, or counts it.
- The *content* of an item is what the item says or holds: text that a person wrote for an audience, the data of a file or a record, or a secret value.

**The rule.** A read that runs with the owner's credential is `metadata` when every result that any valid input can produce holds only descriptions. The read is `private_content` when some valid input can make the result hold content.

**Four consequences of the rule (each from the threat model, not from a tool list).**

1. **The widest valid input decides.** The class belongs to the descriptor, not to one call. If one argument value adds a snippet or a body, the read is `private_content` (T1, T2). Code can make an argument fixed and then declare the narrower class, but that is a separate decision (section 4.5).
2. **A secret is content, whatever its length.** The name of a variable is a description. Its value is content (T3).
3. **The identity of a party is a description.** A name, an address, and a handle say who, not what. The full record of a person (home address, birthday, notes) is the content of that record (T4).
4. **A title is a description.** A subject line, a file name, an issue title, and an event title identify the item, and the owner sees them in every list view. This is the main residual risk: a person writes a title, and a title can hold private words (T4). The boundary is here, so an exemplar for the owner belongs here (see `feedback_principles_over_exemplars.md`).

**Scope.** The class applies only to a read with the owner's credential. A read of the public web (`system.web_search`, `system.fetch_url`) carries no private content and needs no class. A count, a metric, or a rate is a description.

**Short test.** "Could this result tell a stranger what one of the owner's items says, or give them a secret?" Yes means `private_content`.

---

## 3. Inventory

Receipts for the MCP catalogs:

- [F] Production connections and their read-only tools: `select s.endpoint_url, c.status, r.tool_count, ... from mcp_connections c join mcp_servers s ... join mcp_catalog_revisions r ...`. Result: GitHub 28/28 read-only, Notion 36/65, Polylane 2/6, Railway 35/71, Sentry 12/15. Production has no Google Workspace MCP connection yet.
- [F] Dev has the six Google servers and Linear too (same query on `postgresql://alfred:alfred@localhost:5432/alfred`).
- [F] `mcp_tool_policy` has 0 rows in production and 0 rows in dev (`select count(*) from mcp_tool_policy`). So no owner review grants read authority today. All MCP read authority comes from code: the Google pins (`connections/mcp/built-in-tool-pins.ts:14-52`) and the GitHub read-only resource (`connections/mcp/built-ins.ts:151`, `readOnlyCatalog: true`).

Each row: the tool, the class, and a one-line reason. **Hard** marks a hard case (section 3.6).

### 3.1 Curated reads that the policy can gate (not `system.*`)

| Tool | Tier today | Class | Reason |
| --- | --- | --- | --- |
| `contacts.search` (`contacts.ts:39`) | `no_risk` | `metadata` | Names, addresses, and phones of parties: identity, not content. **Hard** (rule 3). |
| `contacts.list` (`contacts.ts:97`) | `no_risk` | `metadata` | Same fields as search, one page at a time. [I] Verify that the list returns no notes. |
| `contacts.get` (`contacts.ts:128`) | `low` | `private_content` | "addresses, birthday, notes, relations" (`contacts.ts:133`): the full record of a person. |
| `vercel.list_projects` (`vercel.ts:28`) | `no_risk` | `metadata` | Project names and states. |
| `vercel.list_deployments` (`vercel.ts:43`) | `no_risk` | `metadata` | Deployment ids, states, and times. |
| `vercel.request` (`vercel.ts:76`) | `no_risk` | `private_content` | Any GET path, with no path filter. [I] Environment variable endpoints can return values, and build logs can hold secrets. **Hard** (T3). |
| `mcp.list_tools`, `mcp.inspect_tool` (`mcp.ts:363,406`) | `no_risk`, `fast_path` | `metadata` | The tool catalog only. `fast_path` never stages a card, so the class has no effect. |
| `mcp.call` (`mcp.ts:205`) | `high`, resolved per call | per remote tool | See 3.3 to 3.5. |

### 3.2 Curated `system.*` reads (never gated: `resolve.ts:115`)

The class has no effect on these reads today, because the `system` floor returns `autonomy`. The class shows where the rule and the floor disagree.

| Tool | Class | Reason |
| --- | --- | --- |
| `system.search_context` (`context-search.ts:17`) | `private_content` | Snippets of memory, ingested documents, and live Drive files. **Hard** (no card today). |
| `system.corpus_search` (`corpus.ts:21`) | `private_content` | Passages of ingested mail and attachments. **Hard** (no card today). |
| `system.read_chat_history` (`system.ts`, action `read_chat_history`) | `private_content` | Raw messages and tool outcomes, but of this thread only, which the model already saw. |
| `system.read_user_context` (`system.ts:449`) | `private_content` | Memory claims about the owner. |
| `system.read_scratch` (`system.ts:474`) | `private_content` | Earlier results of the same run. |
| `system.list_instructions` (`system.ts:587`) | `private_content` | The owner's own instruction text. |
| `system.list_todos` (`system.ts:660`) | `private_content` | Todo text. |
| `system.web_search`, `system.fetch_url` (`system.ts:733,758`) | no class | Public web, no owner credential. |
| `system.search_tools`, `system.load_tool`, `system.current_time`, `system.await_sub_agent` | `metadata` | A catalog, the time, or a join. No item content. |
| `system.code_run` | no class | A carrier. Each nested read keeps its own gate (`code-run.ts:3`). |

[I] The `system.*` rows are consistent with the owner rule only because the owner's own stores are inside the boundary. They are not consistent with T2: an injected instruction in a fetched page can call `system.corpus_search` with no card. This page does not re-open ADR-0040 D5. It names the gap for the owner (section 7).

### 3.3 Google Workspace MCP reads (code pins; 23 reads)

[F] Pins: `built-in-tool-pins.ts:15-51`. [F] Descriptions and argument names: dev `mcp_catalog_revisions.descriptors`. The quoted argument names come from there.

| Server | Remote tool | Class | Reason |
| --- | --- | --- | --- |
| Gmail | `get_message`, `get_thread`, `get_draft` | `private_content` | Message bodies. |
| Gmail | `list_drafts` | `private_content` | [I] A `view` argument exists; the widest view holds draft text. |
| Gmail | `search_threads` | `private_content` | The default view "includes `subject` and `snippet`". The snippet is body text. With `THREAD_VIEW_METADATA_ONLY` it would be `metadata`. **Hard** (rule 1). |
| Gmail | `list_labels` | `metadata` | Label names and ids. |
| Calendar | `list_calendars` | `metadata` | Calendar names and ids. |
| Calendar | `suggest_time` | `metadata` | Free and busy periods. |
| Calendar | `get_event`, `list_events`, `search_events` | `private_content` | [I] A full event holds its description, notes, and meeting links. The title and the time alone would be descriptions. |
| Drive | `get_file_permissions` | `metadata` | Who has which access. |
| Drive | `get_file_metadata`, `list_recent_files`, `search_files` | `private_content` | `snippetVerbosity` defaults to `DETAILED`, and only `excludeContentSnippets` removes content. **Hard** (rule 1). |
| Drive | `read_file_content` | `private_content` | File text and comments. **Hard** (shared files: T4). |
| Drive | `download_file_content` | `private_content` | File bytes (binary output, so it stays direct anyway: `built-in-tool-policy.ts:45-48`). |
| Docs | `read_doc` | `private_content` | Document text. |
| Sheets | `get_values` | `private_content` | Cell values. |
| Sheets | `get_spreadsheet` | `private_content` | "Also returns full grid data if requested" (rule 1). |
| Slides | `read_presentation`, `read_slide_page` | `private_content` | Slide text. |
| Slides | `read_slide_page_thumbnail` | `private_content` | [I] The returned image URL renders the slide content. **Hard**. |

Result: 5 of 23 Google reads are `metadata`. The everyday discovery reads (`search_threads`, `search_files`) are `private_content` by the widest-input rule.

### 3.4 GitHub MCP reads (read-only resource; 28 reads; no pins)

[F] Tool list and descriptions: dev and production `mcp_catalog_revisions` for `https://api.githubcopilot.com/mcp/readonly`. [I] The note "private repository" applies to each row: a descriptor cannot tell a public repository from a private one, so the widest input is a private repository.

| Remote tool | Class | Reason |
| --- | --- | --- |
| `get_me`, `get_teams`, `get_team_members`, `search_users`, `list_repository_collaborators` | `metadata` | Identity of parties. |
| `search_repositories` | `metadata` | Repository names, descriptions, and states. [I] A description is a title (rule 4). |
| `list_branches`, `list_tags`, `get_tag`, `get_label`, `list_issue_fields`, `list_issue_types`, `ui_get` | `metadata` | Names, ids, field definitions, and states. |
| `get_file_contents`, `search_code` | `private_content` | Source code of a private repository. |
| `issue_read`, `pull_request_read` | `private_content` | Bodies and comments. **Hard** (issue bodies in a private repository). |
| `list_issues`, `list_pull_requests`, `search_issues`, `search_pull_requests` | `private_content` | [I] Each item in the result holds its body. Verify with one live call before a pin. **Hard** (rule 1). |
| `get_commit` | `private_content` | The diff. |
| `list_commits`, `search_commits` | `private_content` | [I] The full commit message is text that a person wrote. Only its first line is a title. |
| `list_releases`, `get_latest_release`, `get_release_by_tag` | `private_content` | Release notes are body text. |
| `run_secret_scanning` | `private_content` | It scans content that the model sends, and the result names the secrets that it finds. It also sends that content to GitHub. **Hard** (T3). [F] The catalog has no tool for secret-scanning alerts; this is the only secret tool. |

Result: 14 of 28 GitHub reads are `metadata`. [F] Of the 9 production read cards in 30 days, `get_me` and `search_repositories` (3 cards) would run with no card. `list_issues`, `search_issues`, and `search_pull_requests` (6 cards) would still ask.

### 3.5 MCP servers with no read authority today

[F] Sentry, Railway, Notion, Polylane (production) and Linear (dev) have no review rows, no pins, and no read-only resource. Every call stays at `high` (`risk.ts:122-133`). The class has no effect until the owner reviews a tool. [F] The review path is `reviewMcpToolPolicy` (`tool-runtime/mcp/policy.ts:83`, route at `packages/http/src/mcp.ts:647`).

The class of the hard cases, if the owner reviews them:

- Sentry `search_errors`, `get_sentry_resource`, `search_replays`, `search_logs`: `private_content`. An event or a replay can hold the personal data of end users and request bodies (T4). **Hard**.
- Sentry `find_organizations`, `find_projects`: `metadata`.
- Railway `list-variables`, `get-bucket-credentials`: `private_content` (T3). **Hard**: the server marks both as read-only.
- Railway `get-logs`, `get-function-source-code`: `private_content`.
- Railway `list-services`, `list-deployments`, `get-status`, `http-error-rate`: `metadata` (states and metrics).
- Notion `notion-fetch`, `notion-search`, `notion-query-meeting-notes`: `private_content`. Notion `notion-get-users`: `metadata`.

### 3.6 The hard cases, in one list

| Case | Class | Why it is hard |
| --- | --- | --- |
| Issue and PR bodies in a private repository | `private_content` | The list and search tools also carry bodies, so most GitHub discovery still asks. |
| Mail bodies | `private_content` | Triage already sends every body to the provider, so the card protects T2 more than T1. |
| `search_threads` and Drive search with default snippets | `private_content` | One argument changes the class (rule 1). |
| Drive file content of shared files | `private_content` | Third-party authors (T4). |
| `run_secret_scanning` | `private_content` | A secret read and an outbound channel in one tool. |
| Sentry events with personal data | `private_content` | End users are third parties (T4). |
| Variables and credentials marked read-only by the server | `private_content` | The server hint says "read", and the read is the most sensitive one (T3). |
| `vercel.request` | `private_content` | A raw path can reach secrets. |
| `system.corpus_search`, `system.search_context` | `private_content`, no card | The `system` floor overrides the class. |
| Titles (subject, file name, issue title) | `metadata` | Rule 4. Accept as residual risk, or ask the owner. |

---

## 4. Where the declaration lives

The principle: code owns the declaration, the declaration binds to one exact interface, and absence means `private_content`.

### 4.1 Curated tools

- Add `readSensitivity: "metadata" | "private_content"` to the `liveTool` definition.
- Make the field required by the type when `codeModeRead: true` (a discriminated union on the definition type in `internal/registry.ts`). The compiler then proves that each curated read has a class. This follows the repository rule: the compiler carries the proof, not a test.
- A `system.*` read also declares it. Today the floor ignores it (section 3.2).

### 4.2 Built-in MCP reads (Google pins and GitHub)

- Change each pin from `remoteName: hash` to `remoteName: { hash, sensitivity }` in `built-in-tool-pins.ts`. `builtInToolPolicy` returns the class with the entry (`built-in-tool-policy.ts:60-78`).
- GitHub has no pins today: its read authority is structural (`risk.ts:131`). The structural branch stays the effect authority. A `metadata` class for a GitHub tool needs a pin `{ hash, sensitivity: "metadata" }`. A GitHub read with no pin is `private_content`.
- [I] The class binds to the hash because a new descriptor can add an argument that adds content (the `view` and `snippetVerbosity` arguments of section 3.3 show the pattern).

### 4.3 Reviewed MCP tools (`mcp_tool_policy`)

- Add a nullable column `read_sensitivity` with a CHECK for the two values (`packages/db/src/schema/mcp.ts:277-298`). `null` means undeclared.
- [F] The row already binds to `descriptor_hash` (`mcp.ts:290`, unique index on `connection_id, remote_name, descriptor_hash`). A changed descriptor misses the row, so the class goes with it.
- `reviewMcpToolPolicy` sets the column. The owner sets the class in the same review that confirms the read.

### 4.4 The drift check

- [F] `pnpm --filter @alfred/assistant mcp:policy-drift` lists drifted pins, pins with no live read, and live reads with no pin, and exits 1 (ADR-0096 amendment 2026-11-13). It reads only the Google servers today (`connections/mcp/built-in-policy-drift.ts:18-24`).
- Extend it in three ways:
  1. Report a live read with no class.
  2. On `--write`, give a new or changed pin `sensitivity: "private_content"`. The owner changes it to `metadata` in the diff review. A changed hash never keeps `metadata` by itself.
  3. Read the GitHub server too, for the GitHub pins.
- [F] The script needs a live token, so it cannot be a CI gate, and nothing runs it on a schedule (ADR-0126 residual risk). [I] A drift only removes a `metadata` class, so a missed drift costs an extra card. It never removes a card that should show.

### 4.5 The default for an unclassified MCP read

- An unclassified confirmed read is `private_content`. Under `gated` it asks, as it does today. Under `autonomy` it runs, as it does today. So the default changes nothing for the owner. It never widens silently.
- The class never touches `high`, and it never makes an `autonomy` rule ask.
- A class that depends on an argument value (for example, `metadata` only when `view = THREAD_VIEW_METADATA_ONLY`) is a separate design. It needs a code-owned input check for each descriptor, like `resolveRiskTier`. Do not build it in the first slice. Ask the owner if the extra cards on mail search and Drive search are a problem in use.

### 4.6 The gate change

- Put the class in `ReadFacts` (`read-route.ts:15-23`) as `sensitivity`. `ReadFacts` is already the one record of "is this a read". The route, the tier, and the recovery path read it (ADR-0096 amendment 2026-11-18). The class only counts when `read` is true.
- Change the rule to: approval when `(policyMode === "gated" && !(facts.read && facts.sensitivity === "metadata")) || riskTier === "high"`. Dispatch (`pipeline.ts:1283-1295`), `forecastToolApproval`, and `toolAlwaysWaitsForApproval` (`approval-rule.ts:66-112`) all call this one function, so they cannot disagree.
- `forecastToolApproval` keeps over-reporting for `mcp.call`. `toolAlwaysWaitsForApproval` keeps under-reporting: a curated `metadata` read under `gated` no longer counts as "always waits".
- [I] A consequence: under `gated`, a `metadata` read now goes to the script route (`read-route.ts:45`). ADR-0124 amendment (b) says "Code Mode helps only on an Auto integration". That stops being true for `metadata` reads.

---

## 5. "Tell the user which setting"

### 5.1 Where a block reaches the model and the user today

| Path | What the model gets | What the user gets |
| --- | --- | --- |
| A card stages (`pipeline.ts:1290-1302`, then `waitForStagingApproval`) | The run parks. | The card. The card copy comes from the tier, not from the cause: `policyCopy` (`apps/web/src/routes/-chat/approval-dock.tsx:1011-1020`). For `high` it says "This action can change data outside Alfred", also for an unconfirmed MCP read. |
| The card offers a setting | — | "Always allow this action" and "Always allow {integration}" (`approval-dock.tsx:849-921`). [F] Hidden for `mcp.call` and for `high` (`canAlwaysAllow`, `approval-dock.tsx:1003-1009`). So every GitHub and Google read card has no setting control. |
| The user rejects, or the card expires | `rejected_by_user` with the reason "rejected by user" or "auto-expired" (`pipeline.ts:2257-2268,2290`). No setting fact. | — |
| A script read that needs a card | "This read waits for the user's approval … Call X as a direct tool call" (`pipeline.ts:829-838`). No setting fact. | — |
| A route refusal | `DIRECT_READ_ROUTE_REASON_TEXT` (`packages/contracts/src/tools.ts:113-120`), also in the public error `mcp_read_route_changed`. No setting fact. | — |
| A typed failure | `Fix` has `connect`, `reconnect`, `retry`, `correct_input`, `start_new_thread`, `none` (`packages/contracts/src/app-errors/index.ts:22-28`). No kind names a setting. | The same fix, through the client. |
| A connection that needs reauth | A code sentence in the connected summary: "tell the user to reconnect it in Settings" (`execution/connected-summary.ts:77,163`). | — |
| The Google write guard in local development | A refusal before the staging row (`internal/tools/mcp.ts:173`). It is an environment flag, not a user setting. | — |

[F] The settings that can change the outcome:

- The user default mode, through the chat picker "Review" or "Auto" (`apps/web/src/routes/-chat/approval-mode-options.ts:12-31`; it writes the default: `packages/sync/src/mutators/chat.ts:144-149`).
- The integration mode on the provider page, "Auto" or "Gated" (`apps/web/src/routes/-integrations/detail/provider-policy.tsx:10-13`).
- A tool override ("Always allow this action"), listed on the provider page (`provider-policy.tsx:27`). [F] An override cannot target one remote MCP tool: overrides use `ToolName`, and a built-in `mcp.call` ignores them (`resolve.ts:119-121`).
- Full Autonomy for one thread (ADR-0069 amendment 2026-10-24).
- The owner review of one MCP tool (`reviewMcpToolPolicy`).

### 5.2 The proposal: code supplies the cause and the settings; the model writes the words

1. **One function gives the facts.** Put `approvalCause(...)` beside `callRequiresApproval` in `approval-rule.ts`, with the same inputs. It returns a closed record, not a sentence:
   - `cause`: `policy_gated`, `private_content_read`, `high_tier`, `unconfirmed_read` (the MCP floor), or `forced_arm`.
   - `modeSource`: `tool_override`, `integration_rule`, or `user_default`. This needs `resolvePolicyMode` (`resolve.ts:108`) to return the source with the mode. Today it returns only the mode.
   - `policyIntegration`: the slug whose rule applied (`github` for a GitHub read, not `mcp`).
   - `settings`: the list of settings that would remove the card, from a closed set: `integration_mode`, `tool_override`, `user_default_mode`, `thread_full_autonomy`, `tool_review`. `forced_arm` gives an empty list. `high_tier` gives only `thread_full_autonomy`.
2. **The facts go where a block shows.** Put the record on the staging row (the synced row then drives the card copy and the switches), on the rejected and expired result (`pipeline.ts:2257`), on the script refusal (`pipeline.ts:829-838`), and on the route refusal.
3. **Add one `Fix` kind for a non-approval block:** `{ kind: "change_setting"; setting: SettingKey; integration?: IntegrationSlug }`. An allowlist refusal (`mcp_connection_outside_scope`) or a `feature_disabled` result uses it. The params stay closed enums, as the catalog requires (`app-errors/index.ts:44-49`).
4. **Code owns the links.** The web maps each `SettingKey` and slug to its page. The card shows the setting as a label with no model call. That is the guarantee beside the model (`feedback_model_writes_copy_code_supplies_facts.md`).
5. **The model writes the copy.** The result field carries the fact, for example `whatTheUserCanChange: [{ setting: "integration_mode", integration: "github" }]`. No new prompt rule. The model reads a named field in a tool result, as it reads `retryPolicy` today.
6. **Fix the card for `mcp.call`.** With `policyIntegration` on the row, the card can show "Always allow GitHub" for the right rule. That amends ADR-0125 decision 2 and `canAlwaysAllow`. The staging row should also store `policyIntegration`, because `integration` holds `mcp` (section 0).

[I] Residual risk: the model can still leave out the setting in its reply. The card shows it, so the user always has one path. A coverage check with a re-prompt is not worth its cost here.

---

## 6. ADRs and docs that the decision amends

| Document | What changes |
| --- | --- |
| ADR-0034 (`docs/decisions/ADR-0034-human-in-the-loop-approval-taxonomy-action.md:13`) | Line 13 says that the dispatcher never reads a tool declaration for gating. Now `gated` gates every call except a confirmed `metadata` read, so the gate reads a code-owned class. |
| ADR-0069 | The rule in `toolRequiresApproval` gets the class input. The `high` floor and the Full Autonomy waiver do not change. |
| ADR-0088 | `mcp.call` proposal facts (`risk.ts:58-99`) carry the class from the same identity read. |
| ADR-0096 and its amendment of 2026-11-13 | A pin carries a class. `--write` resets a changed pin to `private_content`. The drift script reports a read with no class and reads GitHub too. |
| ADR-0124, amendment 2026-11-18 and amendment (b) | `ReadFacts` gets `sensitivity`. "Gated reads stay direct" holds only for `private_content` reads. |
| ADR-0125 decision 2 | "With Gated, it shows one" becomes "with Gated, a `private_content` read shows one". The card offers the provider switch for a built-in `mcp.call`. |
| ADR-0126 decision 4 | "The Gmail Auto/Gated setting controls a `low` Gmail read" gets the same split. |
| ADR-0040 D5 | Only if the owner extends the class to `system.*` reads (section 7). |
| `CONTEXT.md:45` (Policy mode) | Remove "no read/write split" and "`riskTier` is a UX hint, never a gating shortcut". Define **Read sensitivity**. |
| `CONTEXT.md:46` (Auto mode (chat)) | [F] Already out of date: it describes a per-thread toggle. Today "Review" and "Auto" set the user default, and "Full autonomy" is per thread (`sync/src/mutators/chat.ts:53-54`). |
| `docs/theory/product-flow.md:162` | "The policy gates every non-system call in Review mode, reads too." |
| `docs/plans/code-mode-object-handles-v1.md:143` | "A read that waits for a card is a direct call" now excludes `metadata` reads under `gated`. |
| `docs/theory/core-agent.md` | Add the owner rule "tell the user which setting" as a principle of the agent voice, with code-supplied facts. |
| `docs/plans/typed-failures-v1.md` and `app-errors/index.ts` | The new `Fix` kind `change_setting`. |
| Web copy: `approval-mode-options.ts:15`, `approval-dock.tsx:1011-1020` | "Review" pauses before actions and private reads. The card copy comes from `cause`, not from the tier. |

---

## 7. Questions for the owner (only the ones that the code cannot answer)

1. **`system.*` reads with private content.** `system.corpus_search` and `system.search_context` return mail and Drive content with no card in any mode. So under `gated`, the card on `gmail.get_message` mostly asks for consent and does not block (T1, T2). Keep the `system` floor (the owner's stores are inside the boundary), or let the class gate these two reads too?
2. **Titles.** Rule 4 makes a subject line or an issue title `metadata`. Is that the owner's meaning of "non-secretive"?
3. **Argument-dependent class.** Mail search and Drive search are `private_content` by the widest input. Is one extra card on these searches acceptable for the first slice?

## 8. Residual risk

- [I] The class is a code claim about a server's output. The server can add a content field with no descriptor change. The hash pin catches a schema change, not a behavior change. MCP treats annotations as hints (ADR-0124, amendment 2026-11-18).
- [I] A `metadata` read still discloses titles and parties to the provider, and an injected instruction can still send them out through `system.fetch_url`.
- [F] No test proves the gate table, by repository policy. The compiler proves that each curated read declares a class (section 4.1). The drift script is manual.
