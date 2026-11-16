# ADR-0127 — The people store is mail history, read from the activity record; the versioned projection and the old graph go

**Status.** Accepted; not built. Decided with the owner on 2026-11-16 (grilling session). Supersedes the projection part of ADR-0067 (`entity_profiles`, `entity_edges`, `entity_co_occurrence`, the run machinery, and significance components), ADR-0057 (the significance score), ADR-0059 (the sender relationship line), and ADR-0051 section 4 (the known-contact flag). Keeps ADR-0067's observation log and its stable `entity_nodes` and `entity_identities`. Agrees with [context-graph.md](../theory/context-graph.md) (a thing is one `entity_nodes` row) and [stores.md](../theory/stores.md) (one copy, derived data that a rule change can rebuild).

**Decision in one paragraph.** The people store answers one question for the model: what is Alfred's history with this address? It answers with facts only, from mail. One reader, `readCorrespondents(userId, addresses)`, gets the facts with one grouped query over the Gmail activity rows in `observations`. No table keeps counts. Code does not give a kind or a score to a person. The model judges the sender from the mail. `entity_nodes` and `entity_identities` stay as the record of a thing and its keys, and a writer makes a node only when something must point at it. The versioned projection and the old graph are deleted.

## Facts this decision rests on (production, 2026-11-15)

- The user-model projection is active. It has been active since 2026-10-30. The active version is 434. The refold makes a new run for each new mail, and no code deletes an old run.
- `entity_profiles` has 133,175 rows (about 140 MB): 434 runs of about 310 rows. `entity_edges` and `entity_co_occurrence` have 0 rows. `entity_nodes` and `entity_identities` have 344 rows, all `email` from `gmail`.
- The old graph: `entities` has 76 rows (34 `organization`, 28 `other`, 14 `person`). `entity_relations` has 0 rows. Memory extraction writes `entities` each night from only some of the mail.
- Gmail `documents`: 2,360 mails since 2026-09-05, about 42 each day. 22 are sent mail. Ingest stores sent mail (`gmail-ingest.ts`), so the user sends little mail from these accounts.
- `observations` has 2,381 `email_message` rows. Each row has the full participant set and the sent time.
- No table has a foreign key to `entity_nodes` or to a projection table, other than the user-model tables.
- Readers of the projection: the triage sender-kind line and floor (`triage/sender-kind.ts`, `classify.ts`). The flag `feature.internal.triage_sender_kind_projection` is not set, and not set means on.
- Readers of the old graph: `read_user_context` (`entities` and `relationships` sections), the mail-facts `knownContact` mark, the triage `Known contact:` line (`readSenderPerson`), the briefing `attentionBand` and suppression gate (`getSenderSignificanceBatch`), `email_triage.sender_significance_band` (synced to the web rail, which renders nothing from it), and reply-drafting provenance.

## The decisions

1. **The job.** The store answers "what is my history with this address?" It does not resolve names: memory's name links do that ([memory.md](../theory/memory.md)). It does not join identities across sources: a claim from the user does that ("my GitHub `foo` is Priya"). It reads mail only for now. Another source adds its own reader when it has a reader that needs it.

2. **The facts for each address.** The name shown (the display name that the address uses most), first seen, last seen, the count of mails from the address and the last one, and the count of mails that the user sent to it (To or Cc) and the last one. All times are sent times. There is no kind, no significance score, no co-occurrence, and no list of which account the mail came to (the mail facts show that for each mail).

3. **No count table.** `readCorrespondents(userId, addresses)` groups the Gmail activity rows in `observations` by address. Nothing keeps the facts current, a retry cannot count a mail two times, and a rule change needs no rebuild. A table that keeps counts was rejected: it is a second home for facts that the activity rows hold (stores.md worst error 4).

4. **The window is stated.** Alfred has stored mail only since the Google connect. Each rendered fact gives the start of the window ("you wrote to them 0 times since Sep 2026"), so the model does not read 0 as never. For older history, the model searches Gmail live (Code Mode, ADR-0124). A backfill of older mail belongs to cold start from the mailbox (theory README, foundation 4). When it writes `documents`, the reader sees the older mail with no change.

5. **Nodes on demand.** `entity_nodes` and `entity_identities` stay. A writer makes a node only when something must point at a thing: a name link or a claim ([memory.md](../theory/memory.md)). Mail does not make a node for each address. The 344 rows in production stay: the id is an HMAC of the identity, so a later write gets the same id. `supersedes_entity_id` stays unused until a user claim joins two identities.

6. **What is deleted.**
   - Tables: `entity_profiles`, `entity_edges`, `entity_co_occurrence`, `projection_runs`, `projection_cursors`, `active_projection_versions`, `entities`, `entity_relations`.
   - Code: the versioned folds and the refold (`gmail-kind-fold.ts`, `gmail-edge-fold.ts`, `gmail-projection-run.ts`, `projection.ts`, `refold.ts`, `reader.ts`), the kind classifier (`entity-kind-classifier.ts`), the old graph (`team-graph.ts`, `entity-graph.ts`, `significance.ts`), the graph step of memory extraction, and their backfill scripts.
   - The triage sender-kind line, the sender-kind floor, and the flag `feature.internal.triage_sender_kind_projection`.
   - The column `email_triage.sender_significance_band`, with its sync and web fields.

7. **The readers after the change.**
   - **Triage.** The `(known contact)` mark and the `Known contact:` line become one history line for each address, for example `From: Priya <priya@x.com> — you wrote to them 4 times, last 2 Oct; they wrote 9 times since Sep 2026`, or `— first mail from this address`. The mail-facts reader gets the history in its one batch read.
   - **Briefing.** Each mail item carries the same history line. `attentionBand` keeps only recurrence. The prompt reads the history, not a significance band.
   - **`system.read_user_context`.** One `people` section replaces `entities` and `relationships`. With `subjectEmail`: the history of that address, also for a first mail. With `query`: addresses whose shown name or address matches a word, until name links are built. With neither: the 20 addresses that the user wrote to most recently.
   - **Reply drafting.** It reads the history through `read_user_context` (`subjectEmail`).

8. **The gates.** The triage deck (baseline 33 of 48, with 12 correct skips) and the briefing eval (baseline 2 of 2) run before and after the reader change. The change ships only if neither is worse.

## Order of work

1. This ADR and the theory pages.
2. `readCorrespondents`, and every reader moves to it, with the two evals. The old tables stay.
3. Delete the old code, and drop the eight tables in one migration. The owner approves the merge, because the drop cannot be undone. The data in these tables comes from mail only, and the user wrote none of it.

## Alternatives rejected

- **(a) Move the readers to the projection as it is.** A cold sender becomes a `person` profile after the fold reads their first mail, so "known contact" is true for a stranger. That is the worst triage error.
- **(b) A `correspondents` table that keeps counts.** See decision 3.
- **(c) Drop `entity_nodes` and `entity_identities` too.** The context graph makes a node the one record of a person, a company, or a repository. Name links and claims point at it.
- **(d) Keep the sender kind until triage slice 3.** The change is the same one that slice 3 makes, and keeping it keeps a full rebuild on each mail. The triage deck is the check.
- **(e) A sent-mail backfill now.** Decision 4.

## Residual risk

- With 22 sent mails, "you wrote to them" is thin until cold start or time adds history. A colleague from before 2026-09 shows as a first sender. The stated window and the live Gmail search are the cover.
- `entity_nodes` has no kind column. The kind was in `entity_profiles`. What gives a node its kind (a claim, or a column that the writer sets) is open. No reader needs it yet ([context-graph.md](../theory/context-graph.md#where-alfred-is-confused-today), item 5).
- The activity rows are the `email_message` header copy today. stores.md step 2 replaces it with a slim activity row. The slim row must keep the participant addresses and the sent time, or this reader breaks.
