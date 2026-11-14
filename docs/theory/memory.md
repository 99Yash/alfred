# Memory: resolve the name, keep claims with evidence, check them each day

This page is the settled theory of long-term memory. It says what memory must do, what counts as an error, and the shape of each part. It gives the theory state and the code state of each part. The owner settled it in a grill on 2026-11-11. [ADR-0123](../decisions/ADR-0123-a-claim-row-is-the-authority-and-cites-its-evidence.md) records the one decision that reverses an earlier ADR.

Last verified: 2026-11-11 at `a35bdaf1d`.

Read first: [context-graph.md](./context-graph.md) (thing, identity, event, fact) and the principles in [README.md](./README.md#2-the-principles). Memory depends on the context graph. It does not depend on the loop theory.

---

## 1. The job

**When the user names a thing, Alfred resolves the name against what it has seen and discussed with the user, before it acts.** The thing can be a repository, a person, a project, a company, or a decision. The rule is the same for each kind. No shortcut applies to one kind only, because the thing can belong to someone else or live in a different place.

**The fault that started this theory.** On 2026-11-08 the user asked chat for "alfred's issues" (prod run `run_s7yi1ymxakcj`). The first step was a document search to learn which repository "alfred" is. Alfred already held the GitHub login of the user and 94 PR rows for `99Yash/alfred`. Nothing could resolve the name, because `context-search/object-state-source.ts` reads exact ids only.

**The worst errors**, in order:

1. Alfred acts on the wrong thing and does not say so.
2. Alfred keeps a wrong claim, and every later run uses it.
3. Alfred overturns what the user said, with no notice.
4. Alfred searches for a thing that it already knows.

## 2. The frame

The frame is [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory) (Anthropic, 2026-11-06). It has five layers. This table maps them to Alfred.

| Layer in the article | Alfred                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Raw record           | Chat turns, mail (`documents`), the activity record (`observations`, ADR-0118), object state, stored page snapshots |
| Notes                | Claims and name links (section 3)                                                        |
| Representations      | Not used now. The context graph holds the structure.                                     |
| Injected context     | The names found in the user's message, resolved at the start of a turn (section 4)       |
| Dreaming             | The check job (section 6)                                                                |

Alfred has three limits that the article does not have:

- **Principle 5.** The system must not learn from itself. Only what the user did or said is evidence of what the user wants. A model output is never evidence.
- **No grader.** Alfred has one user and no benchmark. User corrections and an owner review are the only ground truth (section 7).
- **One user.** The data is small. A daily job over all changed rows is cheap.

## 3. The parts

**Claim.** One statement in memory, about the user or about a thing. Examples: "the user's GitHub login is 99Yash", "Acme uses Vanta". "Claim" is the one term for a memory statement. It replaces "fact" in this sense, because "fact" means a statement from the source that owns a thing (context graph, ADR-0122). The table `user_facts` keeps its old name until a code change renames it.

A claim row holds:

- **A value, and its validity:** the time when it became true and the time when it stopped. An unknown start stays unknown. Alfred does not use the write time in its place.
- **Evidence links.** Each link points to one item in the raw record: a chat message, a mail, an activity event, an object-state fact, or a page snapshot. No claim exists without evidence.
- **The author.** One of two values: the user said it (user-asserted), or the agent concluded it (agent-concluded).
- **The producer.** The pipeline that wrote it, the deployed commit, and the model. On Railway the deployed commit comes from `RAILWAY_GIT_COMMIT_SHA`.

A new value supersedes the old row. Alfred never deletes the history.

**Name link.** The name that the user or a source uses for a thing, linked to that thing. A name is not unique: "Alfred" is the assistant and also the repository `99Yash/alfred`. A name link has the same shape as a claim: evidence, author, producer, validity, and the check. Chat, mail, activity, object state, and the runtime config write name links.

**Alfred itself is a thing.** It has names ("Alfred", its hosts) and links from the runtime config. The prod server has `RAILWAY_GIT_REPO_OWNER` and `RAILWAY_GIT_REPO_NAME`, so "the code of Alfred is `99Yash/alfred`" is evidence from config, not a rule for one kind. Then "alfred's issues" resolves through the self to its repository.

**The observation log stays the activity record.** It records what the user and each source did (ADR-0118). It is evidence for claims. It is not the authority for a claim. ADR-0123 records this change.

## 4. Resolve a name at the start of a turn

1. **Code looks up names.** Before the first model step, code matches the words of the user's message against the name links. The match is normalized text (lower case, trimmed, `owner/repo` also gives `repo`), with the Postgres extension `pg_trgm` for small typos. The lookup queries the rows, so it is always current. No index needs a refresh.
2. **The model selects.** The lookup returns candidates with their evidence. The model selects one from the context (principle 4).
3. **The user decides when the context does not.** The model asks with `system.ask_user` (ADR-0099). It must not select in silence.
4. **A miss is a signal.** A loose description ("the laptop thing") is a search, and `system.search_context` does it. A miss is logged as `none`. A frequent miss shows where a name link is missing.

## 5. Capture: how claims and names are written

- **Every path writes the same rows.** A clarification in chat, mail and activity at ingest, a daily pass, and other workflows all write claims and name links. The ADR-0111 reconciliation sweep is a capture path of this kind.
- **Chat capture runs after a chat response, with a debounce.** Only the user's turns are evidence. The assistant's turns are not.
- **The author label has a code check.** The model can label a claim "user-asserted" only when it quotes the user's words that state it. Code checks that the quote is in that user message. All other claims are agent-concluded.
- **Web research is evidence, and the model judges its credibility.** For one normal person, most pages are pages that the user controls (LinkedIn, a personal site, a GitHub profile). The weak link is the model's synthesis, not the page. So each claim cites the page for that claim, with facts about its credibility: the URL, the domain, whether the user controls it (if known), and the fetch date. Capture stores a text snapshot of the page, so the check can read it again offline.
- **A user correction wins at once.** It writes a user-asserted claim that supersedes the old claim.
- **A user edit to an Alfred output is evidence.** Today these are the `todo_events` rows with the cause `edited` or `dismissed`. The model judges what the edit says. Code does not count repeats. One edit can be enough, for example a corrected due date. For a preference, the claim cites the edits that show it. The difference between an Alfred draft and the mail that the user sent waits until the user uses Alfred drafts.

## 6. The check job

The check job is Alfred's "dreaming". It finds claims that were wrong from the start, and claims that became stale.

**Scope.** It checks only rows that exist: claims and name links. It keeps, corrects, merges, retires, or flags them. It never creates a new claim. A correction is a new version of an existing claim. Standing instructions are not in scope, because an instruction is a command, not a statement that can be true or false (ADR-0113).

**When.** One run each day. Code builds the work set:

- rows whose thing has new evidence since the last check,
- rows that were never checked, and
- rows with an old check.

A limit on rows for each run keeps each model call below 100k prompt tokens. When the work set is larger, the rows with the oldest check go first. The run records the count of rows that it did not check.

**How.** The model is Claude Haiku 5.5 (`claude-haiku-5-5`; see [the Haiku research](../research/claude-haiku-default-model.md)). It writes a Code Mode program (ADR-0087, ADR-0124) that has read host functions only. It has no write host function and no network. The program reads:

- the evidence linked to the row,
- newer evidence about the same thing since the last check, through the context graph (for a claim with no thing, such as a tone preference, the user's own chat turns and corrections), and
- on demand, the source of the producer at its commit. The repository is public, so the program can see how a suspect producer worked.

**Verdicts.** The program returns one verdict for each row: `keep`, `correct` (with a new value), `merge`, `retire`, or `conflict`. Each verdict cites the evidence ids that it read.

**What code does with a verdict.** The model judges, and code enforces the guarantees (principle 4):

| Guarantee                                                                                         | Owner |
| ------------------------------------------------------------------------------------------------- | ----- |
| Each cited evidence id exists, and the host call ledger shows that the program read it.          | Code  |
| An agent-concluded claim whose evidence is all gone is retired (reason `evidence_gone`).         | Code  |
| Retire sets the end of validity and the status. Nothing is deleted.                              | Code  |
| A run applies at most `max(3, 15%)` of its work set as `correct`, `merge`, or `retire`. The other changing verdicts wait for the next run, and the run record logs their count. A bad-producer run that the owner starts has no cap. | Code  |
| A user-asserted claim is never called wrong for its own time.                                    | Code  |
| A user-asserted claim is superseded only by evidence dated after the user said it.               | Code  |
| Supersede a user-asserted claim, or ask the user: this depends on the content.                   | Model |
| When the check supersedes a user-asserted claim, Alfred tells the user in the next briefing or chat, with the evidence and a one-step revert. | Code  |

A user-asserted claim is the authority for its own time, not forever. Example: "I am a junior engineer" was true when the user said it. A later mail about a promotion can supersede it. The check job runs offline, so "ask" becomes a pending question that the next chat or the review surface shows.

**Capture misses.** A `correct` verdict that cites evidence newer than the row gets the tag `capture_miss`. The check repairs the row, and the tag keeps the capture fault visible. Each `capture_miss` becomes an eval case for capture (principle 1).

**A bad producer.** When a producer version is found bad, code adds all rows from that version to the next work set.

**Why the cap.** A model that finds half of memory wrong is more likely to be wrong itself (the same cap is in [the Polylane memory post](../research/polylane-blog-2026-11-11.md#1-memory)). Retire keeps the history, but every chat run reads the result until the weekly review finds the fault. The owner's start is the authority for a larger change.

## 7. Observability: how memory quality is measured over time

Every signal is a Postgres row that Alfred owns. Langfuse input and output capture is off in prod, and it costs too much to turn on.

- **The record of each check run:** the commit, the model, the program source, the host call ledger (each function, its arguments, the evidence ids, and a content hash of each item read), the verdicts, the count of unchecked rows, and the token cost. The record does not copy content. The ids point to the raw record, and the hash shows if an item changed after the run.
- **The verdict log:** one row for each verdict, with the tags `capture_miss` and `evidence_gone`.
- **The producer on each claim**, so a bad producer version is one query.
- **The resolution log:** one row for each name that a turn resolves, with the candidates, the outcome (hit, none, or ambiguous and then asked), and the selected thing. "A name link that Alfred never uses" is a query over these rows.
- **User corrections**, each linked to the claim or the name that it corrects. These are the ground truth.

**What checks the check.** Each week the owner reviews a sample of about 10 verdicts that changed something (`correct`, `merge`, `retire`), with their evidence. Each answer becomes a labelled eval case. A `keep` verdict is not in the sample. The approach can change when model prices fall.

**Every labelled sample, `capture_miss`, and user correction becomes an eval case** in the eval lane. The check is a Code Mode program, so an eval runs it offline with fake host functions (ADR-0087, the #898 scorers).

Until the UI exists, a script prints the weekly report and the review sample.

## 8. Theory state and code state

| Part                                   | Theory  | Code      | The gap today                                                                                                           |
| -------------------------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| Claim row with evidence, author, producer | Settled | Not built | `user_facts.source` holds one pointer, and its default is `{"kind":"agent"}` (`packages/db/src/schema/memory.ts`). `valid_from` defaults to the write time. |
| Name links                             | Settled | Not built | No name kind exists. Object state reads exact ids only.                                                                 |
| Alfred itself as a thing               | Settled | Partly    | `selfIdentityGrounding` gives the hosts and the GitHub App. It does not give the repository.                           |
| Turn-start name lookup                 | Settled | Not built | No lookup runs. Chat pulls memory by tool.                                                                              |
| Chat capture                           | Settled | Partly    | The extractor runs when its flag is on, and it discards its output (`TODO(#399)` in `chat/chat-memory-capture.ts`). The flag is off in prod. |
| Author label with a quote check        | Settled | Not built | Prod has 6 confirmed rows with source `user`, all standing instructions.                                                |
| Web evidence with a page for each claim | Settled | Partly   | Cold start keeps the run id and all URLs of the run, not the page for each claim (`cold-start-research.ts`). Run cold start again under the new capture. |
| Check job                              | Settled | Not built | It needs Code Mode (ADR-0124), which is not built (#535).                                                                          |
| Observability rows                     | Settled | Not built | None of the rows exist.                                                                                                 |
| Weekly review                          | Settled | Not built | No script exists.                                                                                                       |

Prod on 2026-11-11: `user_facts` has 50 rows. Of the 33 confirmed rows, 21 are standing instructions, 8 come from cold start, and 4 come from mail. No row has the default `agent` source.

**Old code that this theory replaces:**

- **The confidence gate.** `proposeFact` confirms a claim at a model confidence of 0.85 or more (`knowledge/facts.ts`, ADR-0019, ADR-0056). The model's own confidence is not evidence (principle 5). Q6 below settles what replaces the gate.
- **The read rule.** `read_user_context` reads `confirmed` rows only (`knowledge/user-context.ts`).

## 9. Not settled

- **Q6 is settled on the use rule (owner decision, 2026-11-14): an unconfirmed claim is usable as weak evidence, with its author label visible ("agent-concluded, not confirmed by you").** Weak evidence never closes a loop (ADR-0109) and never lowers a security label. Confirmation happens in chat — the user's answer to a remark, or any statement that confirms the claim — and in the review section when it exists. Some claims expire and need no confirmation. Still open: the review section's UI.
- **Parked: self-awareness.** Alfred knows its own code, its changes, and the direction of its improvement. The ADRs and the git history are precise sources, but they are too large to load as text. The rows in section 7 are part of the data for it. It extends `docs/plans/runtime-capability-awareness-decision-map.md`, which says that runtime code inspection must not be the default answer path. Settle that tension first.
- **Moved: chat that knows the open matters of the user's life**, such as decisions and conflicts. This is the journal ([journal.md](./journal.md)), not claim memory. Chat capture writes claims, name links, and journal entries in one pass.
- **Parked: trace storage for all agent runs in prod.** The check job needs none, because of its run record.

## 10. Order of work

1. Claim rows with evidence, author, and producer. Remove the default author and the write time as the default start of validity.
2. Name links, and Alfred itself as a thing.
3. The turn-start lookup and the resolution log. Add the 2026-11-08 trace as an eval case.
4. Chat capture with the quote check (#399 rewritten from this page).
5. Cold start again, with a page and a snapshot for each claim.
6. After Code Mode (#535): the check job, the verdict log, and the weekly review script.
