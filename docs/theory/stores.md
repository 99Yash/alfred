# The stores: what came in, what Alfred derives, and what Alfred concludes

Status: draft for owner review, 2026-11-15. The decisions dated 2026-11-15 are owner direction from the foundations session. The rest is the agent's proposal, marked as open where the owner has not decided.

Read first: [README principles](./README.md#2-the-principles), [context-graph.md](./context-graph.md) (thing, identity, event, state), [memory.md §2](./memory.md#2-the-frame) (the raw record and the notes), and [evidence-map.md](./evidence-map.md) (how the model knows what it can read). [ADR-0118](../decisions/ADR-0118-alfred-keeps-one-activity-record-across-every-source.md) is the activity record that this page keeps.

---

## 1. The job

**Alfred keeps one copy of each thing that came in, from every integration. All other data is rebuilt from that copy, or is a conclusion that cites it.** A reader finds each kind of data in one place, with one meaning for each time.

**The fault that started this theory.** One GitHub delivery is stored two times: in `event_receipts.payload` and in `documents.raw`. Code parses it three times, and two consumers read different copies. One Gmail message has three header parsers, a copy of its headers in `observations`, and its triage label in two tables. People live in two graphs. A briefing query selects mail by arrival time and sorts it by sent time (`briefings/gather.ts:310`, `:314`). The owner named this the messiest part of the code (2026-11-15).

**The worst errors**, in order:

1. Two copies of one thing disagree, and a reader trusts the wrong copy.
2. A reader orders events by the wrong time, and the model draws a false chronology.
3. A derived table cannot be rebuilt, so a rule change cannot be replayed.
4. One kind of data has two homes, and each new feature picks one at random.

## 2. The three layers

Owner decision, 2026-11-15: three layers, and every integration writes to them. Mail is one source among many.

```
RECEIVED   what came in, as it came. One copy. One reader for each source.
   │
   ▼       only a fold writes here; code can delete and rebuild each table
DERIVED    the activity record · the state of things · the people graph · the search index
   │
   ▼       evidence points down
MEMORY     claims · name links · journal entries · standing instructions
```

**Received.** Each item that came in: a mail, an attachment, a webhook delivery, a polled event. The body is stored one time, in `documents.raw` (owner decision, 2026-11-15). One reader for each source turns the body into the facts that every consumer reads. For mail, that reader is the mail-facts reader of [triage slice 0b](../plans/triage-theory-v1.md). No consumer parses a body by itself.

- `event_receipts` stays the record of each verified delivery: the dedup key, the verification, the owner, and the processing status (ADR-0097). It holds no body.
- Mail has a property that other sources do not have: the received copy is itself a searchable history, years back. A Code Mode program can read past mail directly. For other sources, the activity rows and the items that they point to are the history.

**Derived.** Each table here is a fold over the received layer. A fold has a version, so a rule change replays.

- **The activity record** (`observations`, ADR-0118). Acts by a person on a thing, and changes of a thing's state category, from every source. A row points to the received item and never copies its body or headers. Mail writes activity rows too: a person sent the user a mail, the user replied.
- **The state of things** (`integration_objects`). The current state of a thing that has a lifecycle. Only the source that owns the thing sets it ([context-graph.md](./context-graph.md#who-owns-which-thing)).
- **The people graph** (`entity_nodes`, `entity_identities`, `entity_profiles`, `entity_edges`). See [section 5](#5-the-people-graph).
- **The search index** (`documents.content`, `chunks`). The text of each received item and its embeddings.

**Memory.** Statements that the user made or that the agent concluded, each with evidence that points to the layers below ([memory.md](./memory.md)). Claims, name links, journal entries, and standing instructions are here. A statement is in words, with no fixed field for its shape. A shift-work week is one claim, not a schema (owner decision, 2026-11-15).

**Outside the layers: Alfred's own outputs.** Triage labels (`email_triage`), briefings, run records, approval rows, and loop checks are records of what Alfred did. They are never evidence of what the user wants (principle 5). The user's act on an output is evidence: a label correction, a dismissed todo.

## 3. Time

Each row in the received and derived layers carries two times. Each time has one meaning:

| Time | Meaning | Example |
| --- | --- | --- |
| **Happened** | When it happened, by the source's clock | The mail's sent time, `pull_request.merged_at` |
| **Received** | When Alfred got it | The ingest time of the mail or the delivery |

- **A window and an order use the happened time.** The received time answers only one question: what is new since the last pass.
- **The model always gets the time now and the user's zone.** Each time that a reader gives the model is in the user's zone, with the weekday. The model works out what came before what.
- **The model knows that it can read these times.** Each store's entry on the [evidence map](./evidence-map.md) names its two times and what they mean (owner direction, 2026-11-15). The briefing is the main reader: mail times and the times of key activities give the chronology that makes the context. Triage can use them, but its cheap first call is not expected to depend on them.
- **A row that has no source clock says so.** The reader shows the received time and marks it as such. It never shows the received time as the happened time.
- **A time in the future is a fact in the source's words.** An expiry, a renewal, or a due date stays in the text of the item, and the model reads it (principle 4). Code does not parse it into a column. When Alfred plans a push or a reminder from it, the push carries its own due time, as an output of Alfred ([core-agent.md](./core-agent.md)). Whether the push comes before or after that time is what makes it useful (owner direction, 2026-11-15).

The columns today, and where they break this rule:

| Table | Happened | Received | Fault |
| --- | --- | --- | --- |
| `documents` | `authored_at` | `ingested_at` | For GitHub, `authored_at` is the arrival time (ADR-0118). The briefing windows mail on `ingested_at`. |
| `observations` | `occurred_at` | from the item that the row points to | — |
| `integration_objects` | `provider_event_at` | `state_delivered_at` | — |
| `event_receipts` | — | `delivered_at` | It holds deliveries, so it has no happened time. Correct. |

## 4. What each table becomes

| Table | Layer | Becomes | Removes |
| --- | --- | --- | --- |
| `documents` | Received + index | The one copy of each body (`raw`), its text (`content`), and both times | The second GitHub body |
| `event_receipts` | Received | The delivery record, with no body | `payload` after the folds read `documents.raw`; the 90-day payload reaper |
| `chunks` | Derived | The search index | — |
| `observations` | Derived | The activity record of every source, rows that point and never copy | The `email_message` header copy (it becomes a slim activity row); `email_interpretation` (triage slice 7) |
| `integration_objects` (+ `_keys`) | Derived | The state of things, rebuilt from received items by the owning source's fold | Writes that a rebuild cannot repeat |
| `entity_nodes`, `entity_identities`, `entity_profiles`, `entity_edges` | Derived | The one people graph | — |
| `entities`, `entity_relations` | — | Dropped ([section 5](#5-the-people-graph)) | The old graph, `team-graph.ts`, `entity-graph.ts`, `significance.ts` |
| `user_facts` | Memory | Claims (ADR-0123) | Standing instructions move out (triage slice 4) |
| `sender_priors` | — | Dropped (principle 5) | Triage slice 1 stops the write and the read |
| `email_triage` | Alfred's output | The triage record | The second copy of the category in `observations` |

## 5. The people graph

Owner decision, 2026-11-15: the new graph supersedes the old one. This agrees with [context-graph.md](./context-graph.md#who-owns-which-thing) (2026-10-21), which gave `entities` no new readers or writers. The old tables can be dropped when no reader is left.

The new graph is empty in production today, because its projection is not active ([context-graph.md](./context-graph.md#where-alfred-is-confused-today), item 4). The readers of the old graph and where each one goes:

| Reader | Goes to |
| --- | --- |
| `knowledge/user-context.ts` (`system.read_user_context`, reply drafting, the triage user line) | The new graph's reader (`knowledge/reader.ts`) |
| `knowledge/significance.ts` (the triage sender line) | Claims about the sender, when triage slice 3 rewrites the prompt |
| `tool-runtime/internal/tools/gmail-recipient-policy.ts` (the send check) | Open ([section 8](#8-not-settled)) |

The graph folds from mail through the mail-facts reader, not from a header copy in `observations`.

## 6. What this page changes in other pages

- **ADR-0038.** Its item 3 ("do not persist raw payloads") is reversed: `documents.raw` is kept as the one copy for every source. The retention of bodies is a security question, held with the other security work.
- **ADR-0122.** It puts three new kinds on `observations`: facts, pointers, and loop checks. This page proposes another placement, for the loops session to decide:
  - A fact is a received item, and `integration_objects` is its projection. This keeps ADR-0122's rejection (d): one record of a state, not two.
  - A pointer ("this evidence touches the user") is Alfred's judgment, so it is an output, not an activity row.
  - A loop check is a run record.
- **evidence-map.md.** Each store entry adds its two times (section 3). The `event_receipts` row changes: it holds no body.
- **context-graph.md.** "Where Alfred is confused today" item 1 closes when the old graph is dropped.

## 7. Theory state and code state

| Part | Theory | Code | The gap today |
| --- | --- | --- | --- |
| Three layers, every source | Settled (owner, 2026-11-15) | Partly | Only GitHub has an activity fold. Two GitHub bodies. |
| One copy of each body in `documents.raw` | Settled (owner, 2026-11-15) | Partly | Gmail: yes. GitHub: two copies. |
| One reader for each source | Settled for mail (slice 0b) | Not built | Three header parsers for mail; three GitHub parses |
| Two times with one meaning each | Proposed | Partly | GitHub `authored_at`; the briefing window |
| The new people graph only | Settled (owner, 2026-11-15) | Not built | The projection is not active; four old-graph readers |
| Outputs are never evidence | Settled (principle 5) | Partly | `sender_priors` (slice 1); the category copy in `observations` |

## 8. Order of work

Each step deletes what it replaces. None of them waits for Code Mode.

1. **This page, and the ADR-0038 amendment.**
2. **The mail-facts reader** (triage slice 0b). The people-graph fold and the activity fold for mail read through it. The `email_message` header copy ends.
3. **One GitHub body.** The object-state fold reads `documents.raw`, and `event_receipts` stops storing the payload. GitHub `authored_at` takes the time from the payload.
4. **The briefing windows on the happened time.** This goes with triage slice 2a, which already changes what the briefing reads.
5. **The people graph.** Activate the projection in production. Move `user-context.ts` to the new reader. The sender line goes with triage slice 3. Then drop `entities`, `entity_relations`, and their writers, when the send check is decided.
6. **The evidence map** carries the two times of each store, when Code Mode lands (#535).
7. **Activity folds for the other sources** (Linear, Calendar, Vercel, Railway), in the ADR-0118 slices.

## 9. Not settled

- **The send check.** `gmail.send_draft` sends live mail, so a recipient must be the user or a person whom the user has written to before. The check reads the old `entities` table. ADR-0126 keeps `gmail.send_draft`, because no Google MCP server sends mail. Two ways:
  - Alfred only makes drafts, and the user sends from Gmail. The send tool and the check go.
  - The send stays, and the check reads the user's sent mail in `documents`, with no graph.
- **A live read that Alfred keeps.** A verified pull or a loop read gives a fact with no received item. Is its result a received item in `documents`?
- **Body retention.** How long `documents.raw` keeps a body. Held with the security work.
- **`memory_chunks`.** One row in production. [memory.md](./memory.md) decides its future.
