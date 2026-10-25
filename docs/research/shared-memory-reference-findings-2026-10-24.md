# Shared memory: Dimension references and earlier Claude decisions

Status: Research for the shared-memory implementation plan, 2026-10-24. No runtime change.

Scope: Saved Dimension mail, its local source dumps, Alfred decisions, and the relevant Claude sessions. The source dumps show code, not which path ran for each past email. Mail shows output, not the internal cause of that output.

## Findings

### 1. Source coverage and retrieval explain much of Dimension's continuity

The work-mail capture includes explicit carry across days and dated uncertainty: the Datomic migration was "carrying since yesterday", and later standup prep says the notes were five days old. The personal-mail capture names PRs, commits, and line counts when GitHub supplied the data. These are useful product requirements: carry a source-backed statement, show the age of its evidence, and say when an update is missing. They do not prove that Zep produced the result. Sources: [work mail](../../references/dimension-work-mails-2026-10-21.txt:91), [migration carry](../../references/dimension-work-mails-2026-10-21.txt:325), [personal mail](../../references/dimension-personal-mails-2026-10-21.txt:1).

The source confirms other continuity mechanisms. Evening composition loads three past evening briefings plus the current morning briefing. A common memory search utility queries Zep nodes and edges, deduplicates results, and returns bounded results. `MEMORY_SEARCH` uses this utility with summarization disabled. Sources: `AI/apps/agent/agent/evening_briefing/main.py:60-142`; `AI/apps/agent/agent/utils/memory_search.py:39-200`; `AI/apps/agent/agent/tools/search/memory.py:34-60`.

Do not turn a prior briefing into new factual evidence. The personal capture contains a no-commit day on May 6 followed by claims of three and four straight shipping days on May 7 and 8. The outputs conflict. Earlier Claude analysis attributed this to carry through prior prose; the mail itself proves the contradiction, not that causal attribution. Alfred should calculate counts and provider state from records. Source: [personal mail](../../references/dimension-personal-mails-2026-10-21.txt:35).

### 2. Shared graph memory in email tagging is an Alfred requirement, not proven Dimension parity

Dimension automatically sends the current user chat message to Zep in a background task. Its search tool exposes persistent memory to agents. However, the inspected Gmail tagging path builds the email content and sender engagement from Gmail, then calls the classifier. It has no Zep read. Sources: `AI/apps/agent/agent/routers/stream_router.py:585-617`; `AI/apps/agent/agent/tools/search/memory.py`; `AI/apps/rag/rag/integrations/gmail/email_tagging/classifier.py:114-160`; `AI/packages/shared/shared/email_tagging/classifier.py`.

Thus the plan should explicitly connect Alfred's triage to the shared knowledge reader. Merely making a memory tool available to chat and user workflows does not make tagging use it.

### 3. Preserve time meanings through the model-facing response

Dimension's formatter warns that its "Recorded" dates do not give relationship start dates. But it chooses `edge.valid_at or edge.created_at` for that label. Copy the clear warning and the inclusion of dates; do not copy the mixing of validity and recording time. Source: `AI/apps/agent/agent/utils/memory_search.py:235-260`.

Dimension's Gmail relationship episodes carry first and last contact dates, total exchanges, role context, and example snippets. This supports the use of evidence-backed relationship summaries, rather than only a contact name and a scalar score. Source: `AI/apps/rag/rag/consumers/gmail/sync.py:738-815`.

The Alfred implementation must retain the distinctions now defined in [ADR-0111 D2b](../decisions/ADR-0111-structured-workspace-memory-claims-sweep-curiosity.md#d2b--memory-keeps-evidence-time-learning-time-and-validity-separate). Recent ingestion must not refresh old evidence. Repeated summary text must not count as independent support.

### 4. A bulk-mail filter can remove the best memory input

The earlier mail investigation found that the notetaker's group summary had list headers and an unsubscribe footer. The Dimension ranking code applies a penalty of 15 for `List-Unsubscribe` and 8 for an unsubscribe footer, against a base of 3. Evening retrieval then applies a minimum score. This explains a credible failure path even though the source dump has no deployment history to establish when that filter ran. Sources: `AI/packages/shared/shared/utils/email_filters.py:470-503`; `AI/apps/agent/agent/evening_briefing/tools/email/get_todays_emails.py:152`; Claude session `4173868b-1239-425b-8902-d0b7932b8140`.

Alfred's latest rule is stronger: a meeting-summary mail must reach the relevant extraction model in every triage category, including `fyi`. Recognition is by its meeting-summary content, not a sender allowlist. Do this before category-based sweep exclusion, so a mistaken `newsletter` tag cannot erase the input. Source: [ADR-0092 A3](../decisions/ADR-0092-notification-referent-dedup-on-the-observation-log.md#a3--meeting-notes-action-items-are-work-items-not-referents).

## Earlier owner decisions to preserve

The Claude session `1928ba8c-2110-49eb-a9ee-dcbf5830c1f2` records the owner's answers behind ADR-0111:

- Structured entities, relationships, and claims; the briefing is their prose surface.
- Claims project from observations, and user corrections take precedence over automatic inference.
- One workspace per connected email account; GitHub orgs and other source scopes map to a workspace. Entities can be shared; claims stay scoped.
- A separate reconciliation workflow about every two hours, with on-demand calls from the agent. The user-fact extractor keeps its narrower job.
- Curiosity runs on low-confidence or old evidence that needs support, rather than on every event.
- Sweep and curiosity share daily accounting of $0.75 per user. A one-time newest-first backfill covers up to 90 days with $2.40 per connected account. These are chosen budgets, not measured cost estimates.
- Disconnect offers archive or delete; archive is the default and has no new research or verification.
- Chat retrieves relevant claims on demand; triage gets at most five supported claims about the sender's org. The memory is not copied in full into the system prompt.

The session ends with owner approval to record the ADR. These answers should be carried into implementation rather than interviewed again. Source: [ADR-0111](../decisions/ADR-0111-structured-workspace-memory-claims-sweep-curiosity.md).

## Conflicts and stale research

1. **Meeting notes.** The older [product direction, section 10d](../theory/product-direction.md#10d-how-dimension-stored-open-work-source-read-2026-10-21) says the ADR-0092 `about` field becomes a list of items with owners. The latest ADR explicitly says that the owner rejected this draft. ADR-0092 keeps one `about` per message. Meeting-note action items need a separate decision. Track the user's items; track a colleague's items only under a standing instruction. A colleague's work can still appear as context. Do not reintroduce automatic tracking for every named person. Source: [ADR-0092 amendment](../decisions/ADR-0092-notification-referent-dedup-on-the-observation-log.md#amendment-2026-10-21-proposed-one-owner-for-each-thing-meeting-notes-leave-this-adr).
2. **Thing ownership.** A provider-owned PR, deploy, or ticket is its `integration_objects` record. A person, org, team, or untracked referent is an `entity_nodes` record. Claims may point to either form. A new memory plan must not add a second object-state authority or a generic work-item table. The latest meeting-note action-item design remains open. Sources: [ADR-0092 A1](../decisions/ADR-0092-notification-referent-dedup-on-the-observation-log.md#a1--a-thing-with-provider-state-is-an-integration-object-not-a-referent-node-amends-d3-and-d5), [ADR-0111 D2a](../decisions/ADR-0111-structured-workspace-memory-claims-sweep-curiosity.md#d2a--a-claim-end-names-a-node-or-an-integration-object).
3. **Budget meaning.** ADR-0111 says sweep and curiosity have a shared cap, but also says the sweep never stops because of it. This is a daily allocation that limits curiosity, not an absolute ceiling on all memory calls. The plan must name that exception, bound each sweep, and measure it. Changing the owner's sweep-priority rule requires a new decision.
4. **One batch per sweep.** This cannot mean an unbounded prompt. Preserve the user's goal of avoiding a model call per event, but use bounded groups, durable progress, and continuations when a window is too large. Exact batching is an implementation design to settle before rollout.
5. **Chat writer target.** The older [chat capture plan](../plans/chat-memory-capture-v1.md) sends entity-subject statements to `entities.metadata` and describes an already registered `enrichment` source. Both are stale. ADR-0092 A2 permits no new legacy entity reader or writer. The current `OBSERVATION_REDUCERS` registry contains only `user`, `alfred_chat`, `gmail`, and `google_account`; register a future source when its first writer lands. Source: `packages/contracts/src/user-model.ts:18-55`. Do not cast an old plan's source name through the present contract.

## Recommended dependencies for the plan

1. Confirm the shadow projection can replay and activate, with no old-graph writes added. Current production state needs a fresh read; the earlier research only establishes the state on its own date.
2. Specify workspace identity, statement time, correction precedence, and the shared bounded read contract before adding a broad extractor.
   Evolve the existing `knowledge.readUserContext` read for structured memory. A registered context-search source can call it. Keep knowledge independent of context-search to prevent a cycle, and keep raw document search and live provider state with their existing owners.
3. Complete at least one chat assertion and correction write into the observation log. Make its derived statement visible to chat, tagging, and user workflows before adding autonomous research.
4. Add passive workspace learning through the separate sweep, including meeting-summary detection before triage category filtering. Preserve source attribution and per-user boundaries.
5. Add verification and curiosity after readers can use the result and tracing can show the effect. Keep loop closure on verified provider evidence. A probable relationship alone cannot close a todo. Source: [ADR-0109](../decisions/ADR-0109-a-soft-edge-closes-a-loop-only-through-a-verified-read.md).

This order proves the shared-memory loop early. It avoids building a large population and research service before any product reader can use its output.

## Source locations and limits

- `AI` = `/Users/yash/Developer/self/-dimension-ai-ai`, inspected at `f9b34ea`.
- The sibling web dump is `/Users/yash/Developer/self/-dimension-ai-web`, at `9672323`; earlier Claude sessions used it for schema and todo lifecycle analysis. This pass did not repeat that full analysis.
- Saved mail captures are gitignored local references. The tracked theory documents summarize them, with the stale meeting-note proposal identified above.
- Claude recall: `/Users/yash/.local/bin/sessions get qmd://claude-sessions/alfred/4173868b-1239-425b-8902-d0b7932b8140.md` and the same command for `1928ba8c-2110-49eb-a9ee-dcbf5830c1f2.md`.
- No live mailbox, production database, or external pricing check was made for this research note.
