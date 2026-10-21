# ADR-0111 — Structured workspace memory: claims project from the observation log, a reconciliation sweep writes them, and a curiosity step reinforces them (PROPOSED — grilled 2026-10-21)

**Problem.** Alfred sorts messages, but it does not understand the user's work. Triage puts a category on each thread. The briefing shows open loops. But no record says "Acme uses Vanta for compliance", "the Q4 launch depends on the billing migration", or "this notetaker mail is the summary of Tuesday's sync". Each pipeline reads the mail again and forgets it again. The current writers cannot fill the gap:

- `memory-extraction` keeps only facts _about the user_. Its prompt drops all third-party facts (`knowledge/extraction.ts:45-58`). That rule is correct, because it stopped the "Weekday" employer bug (ADR-0080).
- Cold-start research is web-only and covers the account holder only.
- No record of a vendor, a tool that the company uses, or a project exists anywhere.
- The ADR-0067 projection runner is not active in prod since the 2026-07-20 reset.

**Decision.** Alfred keeps a **structured workspace memory**. It has seven parts.

## D1 — The memory is structured, with an open vocabulary

The memory is entities, edges, and **claims** in Postgres tables (ADR-0058). A claim can also point to an `integration_objects` row (D2a). The memory is not a prose document. The default `ENTITY_NODE_KINDS` and `ENTITY_EDGE_TYPES` stay. A free label is the wildcard for all other values. Only the values that code decides on get a type. The two lists are closed `z.enum` values today (`contracts/src/user-model.ts:674`, `:816`). Their DB columns are plain `text` with no CHECK, so to open them is a contract change and not a large migration.

The briefing is the prose surface. It reads the structured memory and writes prose from it. The memory itself has no prose layer.

## D2 — A claim is a projection over the observation log

A **claim** is one statement about a workspace: an open label, the statement, its subject, an optional object (the two ends are in D2a), citations, a status, a valid time, and a confidence. Claims are a deterministic projection over the ADR-0067 `observations` log. This is the same pattern as ADR-0080. All writers append observations. Only the projection writes claim rows. A replay rebuilds the table.

- **Confidence is a projection output.** The projection calculates it from the grounding tier (the ADR-0080 ranking), the number of independent sources that agree, and the age of the newest evidence. The model never reports its own confidence, because self-reported model confidence is not calibrated.
- **A user correction cannot be reverted.** A correction or a rejection is a `source=user` observation with rank 0. The projection gives it precedence by construction. No later inference changes it.
- **A claim never restates provider state.** If an integration object owns a fact (ADR-0062, ADR-0092 amendment A1), for example a Linear issue status, the claim points to the object and the reader does a live read. The claim does not copy the value. D2a gives the form of that pointer.
- **The first slice activates the projection runner.** v1 is committed. The `--activate` step has not run in prod.

## D2a — A claim end names a node or an integration object

A claim has two ends: the subject and the optional object. ADR-0092 A1 gives each thing one record. A person, an org, a team, a repository, or a referent is an `entity_nodes` row. A PR, an issue, a deploy, or a ticket is an `integration_objects` row. So a claim end has two forms:

| Form     | What the end stores                  | How a reader finds the thing                                                                  |
| -------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `node`   | the stable `ent_*` id                | the `entity_nodes` row with that id                                                           |
| `object` | `provider`, `kind`, and `externalId` | the `integration_objects` row for the user and the three values (`integration_objects_identity_idx`) |

- **No foreign key.** Both forms are values. This is the ADR-0092 A1a form. The claims table is a projection, and a replay must not fail because a row is missing.
- **The object form stores the tuple, not the row id.** `computeStableEntityId` makes a node id from the user and one identity (`packages/db/src/helpers.ts:95`), so a node id is stable. An `integration_objects` id comes from `createId("iobj")` (`packages/db/src/schema/integration-objects.ts:24`), so it is random. It names one row, not the thing. The tuple is the identity of the thing.
- **The writer picks the form.** The sweep (D4), the curiosity step (D5), and a user correction write the form into the observation. When an `integration_objects` row exists for the thing, they write `object`. If not, they write `node`. The projection copies the form and does not look it up, so a replay gives the same rows.
- **A later provider row does not move a claim.** A claim can name a referent node, and later an `integration_objects` row can appear for the same hard key. ADR-0092 A1 then links the node to the row, and the reader follows that link for its live read. The claim keeps its `node` end.
- **A missing end hides the claim.** If a reader finds no live node or row for an end, it does not show the claim. This is the ADR-0092 A1a rule for a link.

## D3 — A workspace is one connected email account

A **workspace** is the memory scope for one employer, or for the personal life of the user. Its anchor is the `user_org_affiliation` observation that ADR-0080 writes when the user connects a Google account (`accountEmail`, `orgDomain` from the verified `hd` claim). The ADR-0051 account persona (`work | personal`) is a label on a credential. It is not a workspace identity, because it cannot tell two employers apart.

- A mail signal belongs to the workspace of the credential that received it.
- Each GitHub org and each Linear workspace maps to one workspace when the user connects it. With one work account, Alfred selects it automatically. One GitHub login can include personal repos and employer repos, so the map is per org, not per login.
- Entities are shared across all workspaces of the user. Each claim belongs to one workspace.
- All workspaces belong to the sign-up account.

**Disconnect.** The disconnect dialog offers two choices. "Keep as archive" is the default. "Delete" is the second choice. An archived workspace is read-only. Alfred does no research and no verification on it, and chat can still read it.

## D4 — A reconciliation sweep writes candidate observations

A **reconciliation sweep** is a separate workflow. It runs each 2 hours on a cron trigger. The boss and chat can also start it on demand, for one referent or one workspace, with a system tool.

1. **Input.** All ingested data since its cursor: observations, `event_receipts` (raw rows too), and triaged mail. The cursor uses the `projection_cursors` pattern.
2. **Deterministic stage (no model cost).** The sweep skips rows that a reducer already handled, and mail that triage tagged `marketing` or `newsletter`. Then it groups the remaining rows by referent: a thread, an issue, a PR, or an entity.
3. **Model stage.** The sweep makes one batched `cheap`-route call for each run, not one call for each event. The model gives each group one label: `nothing`, `observe` (write a candidate observation), `curious` (put a gap on the curiosity queue), or `act` (propose an action).

The sweep does not replace `memory-extraction`. That workflow keeps its job, which is facts about the user, with its third-party guard.

**Why not each event.** A model call for each event makes the cost follow the volume of mail. Most events need no inference. **Why not extend the `memory-extraction` prompt.** One prompt then has two opposite rules ("skip third parties" and "extract third parties"), and the "Weekday" guard becomes weaker. **Why not extend the triage call.** Triage is the cheap model on the hot path (ADR-0051), and it sees only part of the context.

## D5 — A curiosity step reinforces low-confidence claims

The **curiosity step** is an agent that researches a claim. It runs only when a claim's confidence is below a threshold. A gap (an entity with no claim) counts as zero confidence. An old claim loses confidence with age, so the step also reinforces stale claims.

- **Order.** Low confidence × significance (ADR-0057) sets the queue order.
- **Schedule.** The queue drains each night after the `memory-extraction` cron and before the morning briefing. Chat and the boss can start research on one gap.
- **Sources.** The step uses a live integration read first, then mailbox search, then the web.

## D6 — The budget

- **$0.75 each day for each user**, shared by the sweep and the curiosity step. The sweep runs first and never stops because of the cap. The curiosity step gets the remainder. Gaps that remain go to the next night.
- The cap is the sum of `api_call_log.cost_usd` for the two call kinds since the start of the user's local day. That table prices each call at write time (ADR-0015).
- **Backfill.** When the user connects an account, the sweep processes the last 90 days, from the newest to the oldest, with a one-time cap of **$2.40 for each connected account**. Newest-first means that the cap drops the oldest days first. The order does not change the result, because the projection replays by `occurredAt` (ADR-0080, invariant 5). The curiosity step does not run during the backfill.
- Estimate, not a measured value: one sweep has about 20k input tokens and 2k output tokens on `gemini-2.5-flash-lite`, which is about $0.04 each day, or $3.60 for 90 days. The first slice records the real value. If 90 days cost more than $2.40, the cap stops the backfill early, by design.

## D7 — Readers, verification, and actions

- **Briefing.** It loads the claims for the referents in the items of that day.
- **Chat and boss.** A read tool loads claims when needed. Claims do not go into the system prompt (#405).
- **Triage.** Each message gets a maximum of 5 high-confidence claims about the sender's org, as ADR-0051 pre-model observations.
- **Workspace filter.** The briefing and triage read only the claims of the item's workspace. Chat can read all workspaces, and it labels each claim with its workspace.
- **Verification when used.** A reader verifies a claim with a live read when it can. If it cannot, it states the claim with a flag, for example "Connect Linear to confirm".
- **Actions.** Above a threshold, a verified claim can make a `suggested` todo (ADR-0050) or a staged action that waits for approval. To act without approval, Alfred uses the existing `user_action_policies` `autonomy` mode for that integration. The default stays `gated`. No new autonomy mechanism is necessary.

## Privacy

- The curiosity step can research orgs, vendors, and projects on the web.
- It researches a person only above the ADR-0057 significance threshold, and only for public work-role facts.
- It does no web research on people in the personal workspace.

## UI

`/memory` already shows proposed and confirmed facts with a confidence chip. It gets a workspace switch and a claims section. The user can also correct a claim where it appears, in the briefing or in chat.

## Slices

1. Activate the ADR-0067 projection runner (#218).
2. Add the claims projection with confidence, the two claim end forms (D2a), and the workspace map.
3. Add the reconciliation sweep, the shared cost cap, and the backfill.
4. Add the curiosity step and the on-demand system tool.
5. Add the readers: briefing, the chat read tool, and the triage hint. The briefing reader needs ADR-0092 A1, A1a, and S2 first. A briefing item must carry the key of its thing before the reader can load the claims for it.
6. Add the action proposals, the `/memory` claims section, and the disconnect dialog.

## Alternatives

- **(a) A prose memory document for each workspace.** Rejected. A document cannot carry confidence, citations, or a status for each statement, and a correction cannot be sticky. The briefing is the prose surface.
- **(b) Claims as direct-write rows with a status column (the `proposeFact` pattern).** Rejected. It adds a second source of truth next to the observation log. ADR-0080 rejected the same split for identity facts.
- **(b2) A claim end is always an entity node.** Rejected. ADR-0092 A1 says a thing with provider state is its `integration_objects` row, and no referent node is made for it. A claim about a PR would then have no subject, or it would need a second record for the PR (D2a).
- **(c) Closed claim kinds.** Rejected. A closed list limits what Alfred can learn. Defaults plus a wildcard label keep the vocabulary open.
- **(d) The account persona as the workspace.** Rejected. `work | personal` cannot tell two employers apart.
- **(e) A model call for each event.** Rejected for cost (D4).
- **(f) Two separate caps for the sweep and curiosity.** Rejected. One number is easier to control, and a busy day reduces research before it reduces understanding.
- **(g) Delete the workspace at disconnect, with no choice.** Rejected. The work history belongs to the user. The dialog offers both choices.

## Residual risk

- The confidence formula and the thresholds are not tuned. Slice 2 sets first values, and logs from real data tune them.
- The cost numbers in D6 are estimates. The first slice measures them.
- Notetaker mail is often `fyi`, and the briefing drops `fyi` today (`briefings/gather.ts:95-100`). The sweep reads it, because it reads triaged mail of all categories except `marketing` and `newsletter`.
- The triage payload has no body, To, CC, or list headers (`triggers/index.ts:54-81`). The sweep must load them again through `loadTriageContext` (`triage/store.ts:365`).

**Related.** [ADR-0067](./ADR-0067-multi-source-user-model-substrate-an-event.md) (the observation log), [ADR-0080](./ADR-0080-identity-facts-are-a-deterministic-projection.md) (the projection pattern and `user_org_affiliation`), [ADR-0057](./ADR-0057-passive-memory-capture-the-significance-score.md) (significance), [ADR-0058](./ADR-0058-memory-store-the-postgres-substrate-over-a.md) (the store), [ADR-0051](./ADR-0051-email-triage-v3-cheap-model-always-made-smart.md) (triage and account persona), [ADR-0062](./ADR-0062-integration-object-state-memory-a-deterministic.md) (object state), [ADR-0092](./ADR-0092-notification-referent-dedup-on-the-observation-log.md) (thing ownership), [ADR-0046](./ADR-0046-per-run-cost-ceiling-for-looping-agent-workflows.md) (the per-run ceiling that is still a stub), [ADR-0050](./ADR-0050-todos-persisted-open-loops-hybrid-authored-one.md) (suggested todos).
