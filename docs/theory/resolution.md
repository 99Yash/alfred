# Resolution: find what the user means before Alfred acts

Status: draft for owner review, 2026-11-24. The decisions dated 2026-11-24 are owner decisions. The rest is the agent's proposal from the discussion of 2026-11-23 and 2026-11-24, marked as open where the owner has not decided.

Read first: [README principles](./README.md#2-the-principles), [context-graph.md](./context-graph.md) (thing, identity, name, link), [memory.md](./memory.md) (claims and name links), [journal.md](./journal.md) (entries, past chats that can be found), [evidence-map.md](./evidence-map.md) (how far back each store reaches), and [stores.md §3](./stores.md#3-time) (the two times of each row). The evidence for this page is the research note [how people refer to things](../research/how-people-refer-to-things-2026-11-24.md).

---

## 1. The job

**When the user refers to something, Alfred finds what the user means before it acts, and it says what it found.** The reference can be a name, a set, a relation, a topic, a past episode, a word from earlier in the chat, an item that Alfred showed, or an item on the screen. The same steps apply to each. No shortcut applies to one kind of thing only.

**The faults that started this theory.**

- On 2026-11-08 the user asked chat for "alfred's issues" (prod run `run_s7yi1ymxakcj`). Alfred held 94 PR rows for the repository, but nothing could resolve the name ([memory.md §1](./memory.md#1-the-job)).
- The first plan for name links ([memory-name-links-v1](../plans/memory-name-links-v1.md)) designed from that one example. The owner corrected it two times: "design from the general model, not from the first example" (2026-11-23, the Rosamund and "Rosie" case), and "extrapolate the edge cases to principles, do not derive the code from them" (2026-11-23 and 2026-11-24).

**The worst errors**, in order:

1. Alfred acts on the wrong thing and does not say so.
2. Alfred gives a part of a set, or a part of an episode, as the whole. A source is not connected, is stale, or does not reach back far enough.
3. Alfred says that a thing exists when it has no record of it, or adds details from a different event.
4. Alfred asks when the context was clear.
5. Alfred searches for a thing that it already knows.

## 2. The frame: how people refer

The research note gives the evidence. These findings shape this page:

- **People mix the kinds of reference in one request.** "Play the one from Abbey Road" uses a type and a description together (ReALM). A design that sorts a reference into one kind, and gives each kind its own path, breaks on the first mixed request.
- **Topic and purpose are the strongest cues.** In one mail study, people remembered the topic in 85.1% of tasks, the reason for the mail in 80.9%, the sender in 77.1%, and the time in 57.5% (Elsweiler 2008).
- **Time is a weak cue, and people use it as a filter.** For a group of related items, people remembered the sender in 90.5% of tasks and the time in 34.9%. People seldom type a date (Ai 2017).
- **An episode is built when the user asks, not stored.** TimelineQA calls the step "best-effort". A user found the last oil change by a search for the dealer's name (Ai 2017).
- **Back-references are frequent.** In one assistant data set, 64.2% of the turns after the first turn had a back-reference (CREAD).
- **No source measures how often an assistant asks too many questions.** Alfred must measure it itself (section 9).

## 3. The outcomes

Owner decision, 2026-11-24: **the code is shaped by the outcome, not by the kind of reference.** The kinds of reference are tags on eval cases (section 9), not branches in code.

Each resolution ends in exactly one outcome:

| Outcome                        | What Alfred says                                                                                                                                    | Example                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **One thing**                  | It names the thing that it chose, so that a wrong choice is visible.                                                                                | "Alfred, the repository: 2 open PRs, CI green."               |
| **A set**                      | It states the coverage: the sources that it read, the sources that are not connected, and the sources that are stale.                               | "Railway and Vercel. Railway last synced 2 days ago."         |
| **An episode**                 | It states the reach: how far back each store that it read goes.                                                                                     | "Feb to Apr, from mail. Your chats with me start in October." |
| **An item that Alfred showed** | It names the item.                                                                                                                                  | "The second briefing item: the Sentry alert."                 |
| **None**                       | It says that it has no record.                                                                                                                      | "I have no record of a 2019 tax refund."                      |
| **A question**                 | It asks with the candidates, as outcomes, not as mechanisms ([ADR-0099](../decisions/ADR-0099-a-question-is-an-approval-with-a-different-card.md)). | "The repository, or Alfred in your family?"                   |

An item that Alfred showed can be the thing that the user means. It is never evidence of what the user wants (principle 5).

## 4. Where a referent comes from

| Origin                   | Covers                                                                                  | Store                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The words of the message | Names                                                                                   | The names that sources state, the user's name links, and the runtime config for Alfred itself |
| The thread               | "it", "that one", a reference with no words ("and on Vercel?"), Alfred's earlier output | The chat thread                                                                               |
| The screen               | "reply to this"                                                                         | The item that is open in the web app                                                          |
| Search over the stores   | Topics, properties, sets, episodes                                                      | Mail and chat embeddings, the activity record, the state of things, the calendar              |

**A name lives where its owner writes it.** A name that a source states stays in the source's row: a repository's full name, a deployment's project, a Linear project's name, the display name on a mail. Alfred reads it there at lookup time, and a rename needs no repair. Memory keeps only the names that no source states: the user's own words ("Rosie", an old name of a renamed repository) and the user's answer to a question. This replaces the writer list of [memory.md §3](./memory.md#3-the-parts) ("object state and the runtime config write name links"). See section 10.

**A relation is a link, not a name.** "My wife" can change, and it composes ("Rosie's sister"). It is a link from the user to a person. The name link carries only the words.

## 5. Time

- **Time narrows every outcome. It is not a kind of reference.** "Last spring", "before I moved", "my last oil change" each limit a search. Alfred never needs a time cue to resolve a reference.
- **A time cue is a range with soft edges.** The model turns it into a range in the user's zone. An unknown edge stays unknown. Alfred never fills a missing year from the write time.
- **An episode can be the anchor of a time.** "Before I moved" first finds the episode "the move", then limits the next search by it.
- **Every range and every selector uses the happened time** ([stores.md §3](./stores.md#3-time)). "The last" and "the first" over the received time give a wrong answer for a backfilled thread.

## 6. The steps of a turn

1. **Code finds name candidates before the first model step.** It matches the words of the message against the names that sources state, the user's name links, and the config. It uses normalized text and the Postgres extension `pg_trgm` for small typos ([memory.md §4](./memory.md#4-resolve-a-name-at-the-start-of-a-turn)). Each candidate carries its kind, its source, how it matched, and who wrote the evidence.
2. **The model gets the list of what exists.** Owner decision, 2026-11-24: the kinds are data, not a list in code. The list has one line for each source and kind that Alfred can read, with a count and the last sync time. Example: "Railway deployments 214, synced 3 min ago. Vercel deployments 88." The model maps the user's word ("deployments", "utilities") to the kinds on the list. The user's class is often not a source field, so a list in code cannot hold it.
3. **The turn carries the thread and the screen.** The model reads the earlier turns and the open item directly. They do not go through the lookup.
4. **The model reads the request before it reads a source** (owner direction, 2026-11-24). From the words of the request and the kind of each candidate, it decides which candidates the request fits. Not every question fits every kind: "is it green?" fits a repository, "how is he doing at school?" fits a person. This step reads no source, so it costs only the candidate lines.
   - **One candidate fits:** read only that one.
   - **More than one fits:** ask before any read. A question is cheaper than reads across every path, and a read of the wrong thing is worst error 1. The question shows the options.
   - **The user wants more than one** ("both"): read each, and keep each answer separate.
5. **The model builds the read and runs it in Code Mode** ([ADR-0124](../decisions/ADR-0124-code-mode-is-the-chat-read-path.md)). The read must find things by name, follow the links of a thing, list things by kind with a filter, and read the state and the recent events of a set of things. A search over mail and chats covers topics and episodes. Owner direction, 2026-11-24: give the model the fewest tools that do the job, and spend the fewest tokens (principle 7). Section 12 item 2 holds the proposal.
6. **Code adds the guarantees** (section 7) and writes the resolution log.
7. **The user's answer to a question is user evidence.** It writes a name link or a link that cites the chat turn.

**Example: a repository and the user's son have the same name.** The candidates are the repository (a name that GitHub states) and the son (the user's words, or a mail display name). "What's the status on X?" fits the repository, so Alfred reads it and names it in the answer. "How is X doing?" fits the son. "What's new with X?" fits both, so Alfred asks before it reads, and reads both when the user says "both". The steps are the same for each candidate. Only the evidence is different.

**The token budget.** Each candidate is one short line: the name, the kind, the source, how it matched, and the author. The list of what exists is one line for each source and kind. The model reads a source only after step 4.

**What "status" reads depends on the thing.** For a thing with an owning source, it is the source's state of the thing and of its linked things. A person has no owning source of state ([context-graph.md](./context-graph.md#the-words)). For a person, it is the recent mail and events, and the open journal entries about them.

## 7. What the model owns, and what code owns

| Guarantee or judgment                                                                                                                               | Owner |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Find the name candidates, and give each its source and its author                                                                                   | Code  |
| Read only connected sources                                                                                                                         | Code  |
| Each answer cites the rows that it used                                                                                                             | Code  |
| A set or an episode states its coverage and its reach, from the evidence map and the sync times                                                     | Code  |
| A name match alone never joins two things. A link from a model is a proposal that cites evidence other than the name, and only the user confirms it | Code  |
| Each resolution writes one row to the resolution log                                                                                                | Code  |
| Map the user's words to kinds, links, and a time range                                                                                              | Model |
| Decide which candidates the request fits, before any read                                                                                           | Model |
| Select a candidate from the context, or ask                                                                                                         | Model |
| Build an episode from the hits, and cite each part                                                                                                  | Model |

Weight of evidence, from strong to weak: the user's own words and choices, then the facts of a source and the config, then text that a third party wrote (a mail body). A mail that names "alfred" does not make a candidate as strong as the user's words. This keeps a phishing mail from steering a resolution.

## 8. Links and kinds

**Links.** A relation needs a link between two things. A source fact writes most links: a Vercel deployment states its repository (`vercel-reducer.ts`), and a Linear issue states its PR ([ADR-0122](../decisions/ADR-0122-sources-state-facts-and-pointers-and-a-loop-carries-its-proof.md)). The config writes the link from Alfred to its repository. The user writes a link with a statement or with the answer to a question. A model writes a link only as a proposal: it is agent-concluded, it cites evidence other than the name, and it is weak evidence with its label until the user confirms it. This is the use rule for claims ([memory.md §9](./memory.md#9-not-settled), Q6). An example is the reconciliation of a mail address with a cold-start family member (section 12 item 1).

**A project is a group of linked things.** The repository, its deployments, and the Linear project, joined by links, are the project "Alfred". A two-step query finds the group. An explicit project node is made only when the user names a thing that no source holds, for example "my side project" over several things.

**Kinds.** A set ("all my deployments") and a type ("call him") need a kind on each thing. The model reads the kinds from the list of section 6 step 2. This gives context-graph confusion #5 ("a node has no kind") its first reader.

## 9. How we know that it works

- **The eval set** is the 38 tagged references of [the research note, section 6](../research/how-people-refer-to-things-2026-11-24.md#6-test-references-for-an-eval-set), plus the 2026-11-08 trace. Each case has its tags: name, type, set, relation, property, topic, back-reference, no words, Alfred's output, the screen, selector, episode, time, no referent, self. Cases that the owner adds go in the same set. ADR-0133 makes this set the gate of the first slice.
- **The resolution log** has one row for each resolution: the words, the candidates and their origins, the outcome (section 3), the selected thing, and whether the model asked. A weekly query gives the count of each outcome, the count of questions, and the count of answers that the user corrected next. The questions that the user answers with the first candidate show that Alfred asked too much.
- **Each user correction of a resolution** becomes an eval case.

## 10. What this page changes in other pages

When the owner settles this page:

- **[memory.md §3](./memory.md#3-the-parts):** the writer list of name links becomes "the user's words, and the user's answer to a question". Names that a source or the config states are read in place.
- **[memory.md §4](./memory.md#4-resolve-a-name-at-the-start-of-a-turn):** it points here. The lookup reads the names of sources and config, not only name links.
- **[memory.md §10](./memory.md#10-order-of-work):** step 2 moves after the foundations of section 13.
- **[context-graph.md](./context-graph.md#where-alfred-is-confused-today):** confusion #5 gets a reader (section 8).
- **[memory-name-links-v1](../plans/memory-name-links-v1.md):** superseded until this page is settled.
- **[ADR-0122](../decisions/ADR-0122-sources-state-facts-and-pointers-and-a-loop-carries-its-proof.md) decision 2:** a link joins two `ThingRef` keys, not two `integration_objects` rows, so one end can be in `entity_nodes`, in `integration_objects`, or in no store (option C of section 12).
- **[journal.md §3 and §4](./journal.md#3-the-parts):** the matters of each chat become entries, and an entry keeps the user's own terms (section 12 item 3).

## 11. Theory state and code state

| Part                                     | Theory                                                                                                 | Code      | The gap today                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outcomes, with coverage and reach stated | Settled (outcomes, 2026-11-24); the rest open                                                          | Not built | No answer states its coverage.                                                                                                                                                                  |
| Name candidates from sources and config  | Proposed                                                                                               | Not built | `context-search/object-state-source.ts` reads exact ids only. `selfIdentityGrounding` puts the config names in the prompt, but no lookup matches them.                                          |
| The list of what exists                  | Settled (kinds as data, 2026-11-24)                                                                    | Not built | No reader gives the model the sources, kinds, counts, and sync times.                                                                                                                           |
| Read abilities in Code Mode              | Proposed                                                                                               | Partly    | Reads are per provider (for example `vercel.list_deployments`), plus `system.search_context`. No host function finds a thing by name, follows a link, or lists things by kind across providers. |
| Past chats that can be found             | Settled ([journal.md](./journal.md))                                                                   | Not built | Chat messages have no embeddings.                                                                                                                                                               |
| Links across the two stores of things    | Settled (option C, 2026-11-24): a link joins two keys; a thing that only the user's words hold is open | Not built | No link table exists. `thingKey` (ADR-0122 decision 3c) is not built. A repository is only a `repo` text column.                                                                                |
| The thread and the screen in the turn    | Proposed                                                                                               | Partly    | The thread is in the turn. The open item on the screen is not passed.                                                                                                                           |
| Resolution log                           | Settled ([memory.md §7](./memory.md#7-observability-how-memory-quality-is-measured-over-time))         | Not built | No rows exist.                                                                                                                                                                                  |

## 12. Not settled

1. **Links across the two stores of things.** Settled on 2026-11-24 (option C). The sub-question at the end is still open. The options stay here as the record of the choice.

   **The facts.** A person, an organization, a repository, and a service belong in `entity_nodes` ([context-graph.md](./context-graph.md#who-owns-which-thing)). A PR, a deployment, and an issue are `integration_objects` rows, with other keys in `integration_object_keys`. On 2026-11-15 prod had 344 `entity_nodes` rows, all from a Gmail `email` identity ([ADR-0127](../decisions/ADR-0127-the-people-store-is-mail-history-read-from-the-activity-record.md)). No repository has a node: a repository is only the `repo` text column of a PR or deployment row. [ADR-0122](../decisions/ADR-0122-sources-state-facts-and-pointers-and-a-loop-carries-its-proof.md) (not built) makes a link part of a source fact and puts it in `integration_object_relations`, which joins only `integration_objects` rows. Its decision 3c makes a thing a key from the evidence (`ThingRef`: the owning domain and the canonical URL or id), and it keeps pointer targets as keys, not rows.

   **Option A: one link table, and each end is a row in either store.** Each end has two foreign keys (a node or an object) and a CHECK that one is set.
   - For: the database guarantees that each end exists.
   - Against: both ends must be rows before a link exists. A repository needs a minted node, which brings back the minting of the first name-links plan (the namespace secret, an identity kind for each new kind of thing). A node merge must move its links. Four foreign key columns.

   **Option B: one store for things.** Every thing is an `entity_nodes` row with a kind. `integration_objects` becomes the state of a node. Links join node to node.
   - For: one id space. It removes context-graph confusions #1 (several stores of things) and #5 (no kind) at the root.
   - Against: the largest change. Every PR and deployment needs a minted node. It reverses the ownership table of context-graph.md (owner, 2026-10-21) and changes ADR-0122 and ADR-0127, while both are not built.

   **Option C: a link joins two keys, and a reader resolves each key to its row.** The key is the `ThingRef` of ADR-0122 decision 3c. A source fact writes its links (decision 2). A derived table holds each link: the two keys, the relation, the evidence, the writer, and the validity. Code can rebuild it from the facts ([stores.md](./stores.md#2-the-three-layers)). One reader maps a key to its row in either store. A key with no row is an open thing (decision 3b), and it still answers "these deployments build this repository".
   - For: it reuses ADR-0122 (the key, the targets that stay keys, open things). No minting: the repository is its GitHub URL, with a row or not. Alfred itself is its web origin, so the config link "Alfred → its repository" is two keys, and no `self` identity kind is needed. A row that arrives later matches with no backfill.
   - Against: no foreign key, so a link can name a key that no row holds. This is by design (an open thing), but a wrong key is not caught by the database. Every writer must build keys with one function (`thingKey` of ADR-0122, not built). A person has no URL. The person arm of the key is the canonical `email` identity, which `entity_identities` already holds.

   **Owner decision, 2026-11-24: option C.** It is reuse, not a new structure (principle 3). It needs no minting. It keeps a source's names and links where the source states them (section 4). It does not block B later: keys stay valid if the stores become one.

   **A thing with no key from a source.** "My son Alfred" has no mail address, no URL, and no row. Owner direction, 2026-11-24:
   - **Cold-start research is the first source** for the people around the user, until a better one exists. A cold-start claim about a family member makes a key scoped to the user, with the claim's pages as evidence. The user's own words in chat make the same kind of key.
   - **Later evidence is reconciled with it.** When mail or another source shows an interaction with the family member, a capture path proposes a link from the source key (for example the mail address) to the cold-start key. The proposal cites both evidences.
   - **Limit today.** Cold start is web-only and runs one time. Its relation guard reports at most a one-line mention of a third party, and for a minor child at most "exists, how many" ([cold-start reference](../reference/cold-start.md)). So for most family members the first key comes from the user's words or from mail. Cold start needs a revamp (owner, 2026-11-24). That revamp is separate theory work ([README, cold-start row](./README.md#3-the-user-lifecycle)).

2. **The read abilities.** Owner direction, 2026-11-24: the fewest tools that do the job. Proposal: one Code Mode host function over the stores of things, with a small typed query (by name, by link, by kind and filter, and the state of a set). Each host function adds lines to the Code Mode index that every run pays for. Four functions with one shape each cost more prompt than one function with one input type.
3. **Chat matters as journal entries, and the words of the user.** Owner direction, 2026-11-24: the matters of each chat are saved as journal entries, and an episode that Alfred builds for the user is one of them. Today [journal.md §4](./journal.md#4-write-who-writes-an-entry) lets the model decide what is worth an entry. The owner's warning: the note is in the model's words ([journal.md §3](./journal.md#3-the-parts)), and the user later asks in the user's own words ("the job hunt", not "applications to Acme and Globex"). The research note shows the same gap (TimelineQA: "a drink with a friend" against "went to a bar"). Proposal:
   - The note keeps the user's own terms for the matter, quoted, next to the model's summary.
   - The chat-time search matches the user's message against the raw chat turns too, not only the notes. The turns hold the user's words. The note is the pointer.
   - Each user question that hits an entry with words that are not in it adds those words to the entry.

   This changes journal.md §3 and §4, so the owner settles it there.

4. **Who wrote the evidence.** Owner direction, 2026-11-24: there can be more than one author, and the user's setup tells who each is. Proposal: keep the claim author of [memory.md §3](./memory.md#3-the-parts) as it is (who concluded the claim: the user or the agent). Add the writer of each evidence item, which the setup gives:
   - a chat turn: the user;
   - the runtime config: the operator of the deployment. Alfred has one user, who controls the system, so the operator is the user. The setup states this fact. Code does not assume it for each value;
   - a source fact: the provider;
   - a mail or a page: its sender or its site, a third party unless it is the user's own;
   - an Alfred output: Alfred. It is never evidence (principle 5).

   The weight of evidence in section 7 reads this writer. One claim can have evidence from several writers.

## 13. Order of work

1. The cold-start revamp, as separate theory work. Until it lands, family members get their first key from the user's words or from mail, and step 5 can still build.
2. Past chats that can be found (the first step of [journal.md §11](./journal.md#11-order-of-work)). It serves the journal and this page.
3. The list of what exists, and the name candidates from sources and config. Gate: the 2026-11-08 trace and the name, self, and set cases of the eval set.
4. The coverage and reach statement for sets and episodes.
5. `thingKey`, the link table of key pairs, the reader from a key to its row, the writers from source facts and config, and the relation cases of the eval set.
6. Name links from the user's words and from the answers to questions (the remaining part of [memory.md §10](./memory.md#10-order-of-work) step 2).
