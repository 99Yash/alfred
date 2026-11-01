# ADR-0118 — Alfred keeps one activity record across every source, and one typed identity names each source

**Status.** Proposed; not built. Amends ADR-0067 (what the observation log records), ADR-0097 (each inbound source declares a route), ADR-0101 (who reads by default), and ADR-0062 (object kinds for a custom MCP server). Generalizes the ADR-0104 rule from Drive to every source, and the ADR-0117 provenance rule from the briefing to every reader of the record. The claims plan ([shared-context-memory-v1](../plans/shared-context-memory-v1.md), ADR-0111) builds on the same log.

**Decision.** The observation log becomes the one record of **what happened when** across every connected source, built-in or added by the user. Each source declares a route: ingest, live, or tools only. One typed identity, `SourceIdentity`, names a source in every layer: the record, object state, documents, and Context Search. A known MCP server resolves to its registry slug, and a custom server is named by its stable server id, never by a string match. Each reader gets the coverage of each source with the events, so "no events" and "no source" are different results. The first consumers are the briefing and a rhythm view that tells a routine hour from an unusual one.

---

## Why

Long-term memory is what makes a personal assistant useful. The owner's goal is that Alfred knows what goes on everywhere, knows when it happened, and uses that knowledge to respect the user's choices when it acts.

These facts are from production and the code on 2026-11-01:

- **The event log covers one provider.** `OBSERVATION_REDUCERS` (`packages/contracts/src/user-model.ts:46`) has four sources: `user`, `alfred_chat`, `gmail`, and `google_account`. GitHub activity goes to `event_receipts` and `documents` only. ADR-0067 planned GitHub (P2) and Calendar (P3) reducers, but they are not built.
- **Most sources send nothing.** In 30 days, `event_receipts` got 1,262 Google and 672 GitHub deliveries. Linear, Calendar, Notion, and Slack got zero. Alfred reads them live, through tools, only when the chat agent decides to. The 672 GitHub rows start on 2026-10-28. The GitHub credential was created again on that day, and the `credential_id` cascade deleted the older receipts.
- **A dead source is silent.** On 2026-10-27, the GitHub App credential was missing after the key rotation, every webhook dropped, and the morning briefing did not report 27 PRs that merged overnight. Nothing recorded that the source was blind.
- **Six lists name a provider.** `IntegrationSlug`, `BuiltInMCPProvider`, `ObjectStateProvider` (`github`, `railway`, `vercel`, `mcp`), `LoopEntityProvider`, `ObservationSource`, and `DocumentSource`. Each layer keeps its own list.
- **A custom MCP server has no name in object state.** A reviewed health mapping (`mcp.ts:720`, `object-state/mcp-reducer.ts`) writes every custom row as provider `mcp` and kind `connection_health`. The connection id is packed into `externalId` as `connectionId|loopKey` (`object-state/events.ts:59`). The mapping's `identityProvider` must come from the closed `LOOP_ENTITY_PROVIDERS` list, so a new product or an internal tool cannot name itself.
- **The record is noisy where it exists.** About 21,000 of 31,297 GitHub documents are `workflow_job` deliveries.
- **Dimension had no activity table.** Its evening briefing read GitHub and Linear live at compose time and carried continuity through the last three briefings in the prompt ([product-direction §10](../theory/product-direction.md)). That works for one day. It cannot tell a routine from an exception, and it cannot see a source that stopped.

## Decisions

### 1. The observation log is the activity record

ADR-0067 records relationship evidence. This ADR adds a second kind of row: **activity**. An activity row records one of two things:

- **An action by a person on a thing.** Examples: the user merged a PR, a colleague commented on an issue, the user accepted an invite.
- **A change of a thing's state category.** Examples: a deploy went from `active` to `failed`, an issue went to `resolved`. A delivery that does not change the category (a second green CI run) is not an activity row.

Each activity row has these fields. Each field uses an existing column of `observations` or a typed payload in `@alfred/contracts`:

| Field | Meaning |
| --- | --- |
| `occurredAt` | The provider's time for the event, not the arrival time |
| source | A `SourceIdentity` (decision 2) |
| actor | A person identity, or `{ kind: "user" }` when the user did it |
| verb | A closed vocabulary for each source kind, for example `opened`, `merged`, `commented`, `state_changed` |
| object | The thing's identity, the same key that `integration_objects` uses |
| receipt | The `event_receipts` id that carries the body. The row does not copy the body. |

A reducer for each source writes these rows, with the ADR-0067 dedup (`family_key`, `evidence_hash`) and supersession. A replay from stored receipts rebuilds them.

- **The actor is not the webhook `sender`.** GitHub sets `sender` to the user on 7,111 of 7,145 `workflow_job.completed` deliveries, because the user started the run. Each source declares an allowlist of verbs. A delivery outside the list is not an activity row, even when the sender is the user.
- **`occurredAt` comes from the payload.** `documents.authored_at` for GitHub is the arrival time (median lag 0.01 s from `ingested_at`). A replay reads the provider's timestamp from the body, for example `pull_request.merged_at` or `head_commit.timestamp`.
- **One merge is one action.** A merge sends a `pull_request` `closed` delivery and a `push` to the base branch. The reducer records one row for the merge.

`event_receipts` still keeps every verified delivery (ADR-0097 item 9). The record keeps only the two kinds of rows above. A `workflow_job` delivery is state on its object, not an activity row. Alfred's own writes stay in the ADR-0115 ledgers. A reader can join them, but they are not activity rows.

### 2. One typed identity names each source

```ts
type SourceIdentity =
  | { kind: "integration"; slug: IntegrationSlug } // built-ins; a known MCP server resolves here
  | { kind: "custom_mcp"; serverId: McpServerId }; // a server that the user added
```

- A known MCP server resolves to its registry slug through `BUILT_IN_MCP_CATALOG` and `builtInProviderForEndpoint`. A Linear row from the Linear MCP is `linear`, not `mcp`. A new built-in server is one catalog entry, and each table keyed by the union fails `check-types` until it handles the entry.
- A custom server is named by `mcp_servers.id`, through a new branded `McpServerId` type. That id stays the same across reconnects. The self-reported `serverIdentity.serverName` is a label for display, never a key.
- The account is a separate field: the credential id or the MCP connection id, as `documents.accountId` is today. Two accounts on one server are one source with two accounts.
- The database stores the union as a closed provider column plus a nullable `mcp_server_id`. A CHECK requires the server id when the provider is `custom_mcp` and forbids it otherwise. One parser in `@alfred/contracts` reads the two columns into the union at the boundary.
- `integration_objects` gets the same columns. A custom server's `externalId` no longer packs the connection id.
- `LOOP_ENTITY_PROVIDERS` splits. The members that are registry slugs derive from the registry. The members that Alfred finds only in mail (`clickup`, `jira`, `asana`, `trello`, `issue`, `monitoring`) stay a separate closed list. A custom server's mapping names its own server, not a member of that list.

### 3. Each source declares its route

The ADR-0104 rule applies to every source. A thing that does not change after it occurs is ingested. A thing that the owner edits is read live, because a stored copy becomes stale and a revoked share must stop being evidence at once.

| Route | Meaning |
| --- | --- |
| `ingest` | Events arrive by push or by poll, and a reducer writes activity rows |
| `live` | A Context Search source reads the provider at query time (ADR-0101, ADR-0104) |
| `tools_only` | The tools work in chat. The record has no events from this source, and the integrations page says so. |

A source can have more than one route. Calendar ingests past events and reads future events live.

- **Built-in.** The route is a required field on the `INTEGRATIONS` entry (ADR-0093), so a new entry does not compile without one. The first routes: Linear issues and comments, `ingest`; Slack messages, `ingest`; Calendar, `ingest` for past events and `live` for future events; Notion, `live`; Vercel and Railway deployment events, `ingest`; GitHub, `ingest` (already built).
- **Custom.** The owner sets the route at review, and it is stored with the server:
  - `ingest` by push: a signed webhook URL and secret for each connection. Each delivery becomes a raw receipt with a generic description. Its verb is `delivered`, and it has no actor unless the review declares a field for one.
  - `ingest` by poll: the reviewed health mapping, extended so that it declares its object kinds (decision 5).
  - `live`: a Context Search adapter over one read tool. Alfred proposes the tool from the catalog, and the owner confirms it.
  - `tools_only`: the default when the owner declares nothing.

### 4. Coverage is part of the record

Each source keeps its route, the time of its last event, and the state of its connection. The reader states each source's coverage in the ADR-0117 vocabulary: `live`, `stale`, or `unavailable`, with a cause and an ADR-0100 recovery. A reader that gets no events from an `unavailable` source must not say "nothing happened". This applies ADR-0117 decision 1 to every reader of the record, not only the briefing gather.

### 5. A custom server declares its object kinds

The reviewed mapping declares a kind name and one lifecycle preset for each kind it maps. A preset is a complete `ObjectKindDef` (ADR-0062: `closesAskOn`, `closesAskFrom`, `absorbing`, `todoIdentity`). The first presets:

| Preset | Example | Shape |
| --- | --- | --- |
| Work item | A ticket, a task | Closes on `resolved` or `abandoned`; `resolved` is absorbing; one identity is one piece of work |
| Run on a target | A build, a deploy | Closes by a successor on the same target; nothing is absorbing; not a todo identity |

The kind is scoped by the server, so two custom servers can each have a kind named `task`. The current `connection_health` rows migrate to the server id and the "run on a target" preset. A custom row still cannot override a built-in provider's verdict.

### 6. Readers read the record by default and apply the user's choices at read time

- One local reader in `@alfred/assistant/knowledge`, beside `readUserContext`: `readActivity({ userId, window, subjects?, sources? })`. It uses no embedding, no model, and no provider call. It returns events in time order and the coverage of decision 4. A Context Search source adapter calls it, as the claims plan does for claims.
- The briefing, meeting prep, and todo closure read their window from it. Chat reads it at the start of a turn, within a local cost budget, so a turn does not wait for a live source.
- The triage tag path does not read it (ADR-0113, alternative (d)).
- The stored record never changes because of an instruction. A reader applies the user's current standing instructions when it reads, as `deriveEffectiveTriage` does for mail. An instruction can demote an event. It never deletes the event.

### 7. The rhythm view tells a routine from an exception

The first projection over the record is the user's own actions for each local hour and weekday, over a trailing window. The zone comes from `settings({ userId }).timezone()`. For each user action in a reader's window, the view marks it `routine` or `unusual` against that baseline. It also lists any travel evidence: calendar events in another zone, and the location evidence of ADR-0117 decision 3.

| What Alfred knows | What Alfred does |
| --- | --- |
| The hour is routine, or an instruction says so ("I work late") | It says nothing about the hour |
| Travel evidence exists | It asks whether the user is in that place and offers to change the time zone. It never changes the setting without approval. |
| No explanation exists | It addresses the hour in context, for example "You merged 12 PRs between 1 and 3 a.m." |

Code supplies the baseline, the mark, and the evidence. The model writes the words. With too little history, the view marks nothing.

A back-test on the owner's GitHub actions (2026-09-06 to 2026-10-31, 49 active days, `Asia/Calcutta`) sets the first values:

- **The unit is an active day in an hour, not an event.** One hour can hold 100 deliveries, so an event count lets one busy hour set the baseline.
- **An hour is routine when it has activity on at least 20% of the active days in the window.** At 10%, three late nights in one week (2026-09-21 to 2026-09-24) made 00:00 routine after three weeks of history. At 20%, the routine hours stay 06:00 to 22:00.
- **The minimum history is 14 active days.** With 7 days, the view marked 21 of the next 42 active days. With 14 days, it marked 8 of 35. The marked hours were 00:00, 02:00, 06:00, and 23:00.

The baseline uses GitHub only until another source records the user's actions. The 2 a.m. case occurred one time in 49 days (2026-09-24, two actions). So the view must stay quiet on almost every day.

### 8. The text index follows the record

`documents` and `chunks` stay the text projection for search. A receipt that does not pass decision 1 gets no embedding. The documents that the daily cap blocked are admitted again only if they pass decision 1.

## Rejected alternatives

- **(a) A new activity table.** It would be a fifth store that holds events. ADR-0067 and the context-graph glossary already name `observations` the event log, and the ADR-0111 claims build on it. One log lets a claim cite the activity that supports it.
- **(b) Live reads only, as Dimension did.** A live read sees only the provider's window and only when a source works. It cannot build a baseline, and a dead credential looks like a quiet day.
- **(c) Embeddings as the record.** A vector search cannot answer "what happened between 22:00 and 03:00" or "how often does the user work at 2 a.m.".
- **(d) One provider list in each layer, as today.** The lists drift, and a custom server cannot name itself.
- **(e) Match an MCP server by its name.** The server reports its own name, and the name can change. The canonical resource and the server id do not.
- **(f) Change the time zone from evidence without approval.** A VPN or a short trip makes a wrong silent zone worse than a stated default (the same reason as ADR-0117 decision 3).
- **(g) Every delivery in the record.** About two thirds of the GitHub deliveries are `workflow_job` events. They would bury the user's own actions and distort the rhythm view.

## Preserved behavior

- `event_receipts` keeps every verified delivery with an owner (ADR-0097 item 9).
- The existing observation sources, reducer ranks, dedup, and supersession do not change.
- An activity row is evidence, not state. Only a deterministic reducer sets object state, and only a positive provider signal closes a loop (ADR-0062, ADR-0109).
- A custom MCP row cannot override a built-in provider's verdict, and the owner still reviews each mapping.
- The triage tag path reads no embeddings and no activity search (ADR-0113, alternative (d)).
- Postgres stays the only store (ADR-0058).

## Residual risk

- **The user's own actions need the user's GitHub identity.** Alfred knows it from a `github_username` fact or a commit-email bridge (ADR-0067). Production has the fact (`99Yash`) on 2026-11-01. Another user without the fact gets an empty rhythm view.
- **History has holes.** No GitHub delivery arrived from 2026-10-23 to 2026-10-27 (local time). A replay cannot restore those deliveries. The coverage of decision 4 marks the gap; it does not fill it.
- **A credential cascade deletes receipts.** `event_receipts.credential_id` cascades, so a new credential erases the old receipts. The GitHub bodies before 2026-10-28 survive only in `documents.raw`, which is keyed by user. Until the receipts outlive a credential, `documents.raw` is the replay source for that history.
- **A custom push payload has no schema.** Its description is generic, and its events have no actor unless the review declares one.
- **A short history gives false exceptions.** The minimum history in decision 7 is the guard. Its value comes from one user on one source, and 49 active days.
- **The volume is larger than first expected.** From 2026-09-06 to 2026-10-31 the user made 3,629 GitHub actions: 2,207 pushes, 471 merges, and 951 other actions. That is about 2,100 rows each month, or about 840 without pushes. Postgres holds this volume easily. A reader that puts the rows into a prompt must summarize them.

## Implementation slices

1. The required route field on each `INTEGRATIONS` entry, set to what is built today, and an "Activity record" note on the integration page that reads it. No data changes. `SourceIdentity` waits for slice 2, because a type with no reader fails the `knip` gate.
2. `SourceIdentity` and its parser in `@alfred/contracts`, and the GitHub activity reducer as its first writer, with replay and the coverage of decision 4. The replay reads `documents.raw` for history before 2026-10-28, and `event_receipts` after it. Proof: replay 2026-10-27. The read must report GitHub as `unavailable` from 2026-10-22, not as quiet. The old credential row is gone, so the coverage for that window comes from the time of the last event.
3. `readActivity`, and the briefing reads "since the last briefing" from it. This slice ships with ADR-0117 slice 2, which adds the same provenance type to the gather.
4. The rhythm view and the three results of decision 7, in the briefing and in chat.
5. Custom servers in object state: the `mcp_server_id` columns, declared kinds with presets, the migration of the `mcp` rows, and the split of `LOOP_ENTITY_PROVIDERS`.
6. New ingest routes, one slice for each: Linear, Calendar past events, Slack, Vercel and Railway deployments, and the custom signed webhook.
7. Default reads in chat, meeting prep, and todo closure, and the Context Search adapter.

Slice 2 also delivers the GitHub part of slice 7 of the claims plan. The corpus fixes (the `hnsw.iterative_scan` setting, and no embeddings for `workflow_job`) do not depend on this ADR. The `workflow_job` fix follows decision 8.
