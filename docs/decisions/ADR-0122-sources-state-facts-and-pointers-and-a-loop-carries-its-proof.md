# ADR-0122 — Each source declares what it can tell, a state is a projection of facts, a pointer says what touches the user, and each loop verdict carries its proof

**Status.** Proposed; not built. Decided with the owner on 2026-11-07. Supersedes ADR-0120 decisions 1, 3, 4, 6, 8, and 9. It keeps ADR-0120 decisions 2, 5, 7, and 10. Amends ADR-0062 (a provider becomes a source, and the state table becomes a projection), ADR-0092 (any source can write an `about` link, not only the mail classifier), ADR-0093 (an integration entry declares what it can tell), ADR-0118 (builds decision 2, and uses the presets of decision 5 for every source), ADR-0109 (rule 2 becomes the one link rule; rule 3 stays for soft edges only), and ADR-0048 (the loop verdict is stored, with its proof).

**Decision in one paragraph.** Alfred has four primitives. A **source** declares, as typed data, the things that it can tell about. A **fact** is one statement from a source about the state of one thing; `integration_objects` is a projection of the facts. A **pointer** is one statement that a thing, or a condition in the user's words, touches the user; any source can write it. A **loop** is the view of one thing or condition that pointers hold open; `verifyLoops` gives each loop a verdict and the proof of that verdict, and it records each change of verdict. The briefing gather is one function over generic readers, and no line in it names a provider.

## Why

These facts are from the code on 2026-11-07, after PR #1690:

- **Each layer has its own list of providers, and the lists disagree.** `OBJECT_STATE_PROVIDERS` holds `github`, `railway`, `vercel`, and `mcp`. Four tables are keyed by it: `INTEGRATION_OBJECT_DEFS`, `OBJECT_STATE_ADAPTERS`, `VERIFIED_PULLS`, and `LOOP_VERIFIERS`. The activity tables (`ACTIVITY_SOURCES`, `SilenceEvidence`) hold GitHub only. `loop-key.ts` has a third list (`clickup`, `linear`, `jira`, and others), and `MCP_HEALTH_IDENTITY_PROVIDERS` has a fourth. The registry (ADR-0093) says that Railway is `planned` and `tools_only`, but Railway is a full object-state provider. None of these lists derives from `INTEGRATIONS`.
- **A new source needs about ten edits.** It needs an event union member, a reducer branch in `store.reduce`, an adapter, a verified pull, a verifier, an `OBSERVATION_REDUCERS` entry, an `ACTIVITY_SOURCES` entry, a `SilenceEvidence` member, a trigger consumer, and the gather wiring.
- **The gather names providers.** It has the inputs `deploy_status` and `github_merged`, a GitHub fallback in `gatherDayShape`, a fold of the MCP health read before `verifyLoops`, and an open-ask guard that sees only GitHub pull request URLs.
- **The mail link sees GitHub only.** In prod on 2026-11-07, the `email_interpretation` rows in `urgent` hold 9 mails and 0 keys. The keys come from the regex grammars, and only the GitHub grammar gives real keys.
- **No record explains a verdict.** `loop_verification_runs` holds counts only. The reason that a thing is `unverified` lives in memory for one run. Nobody can answer "why was this loop open on 11-08?".
- **A loop must be a thing today.** "Rotate the Railway credentials" and "until the landlord replies" have no `integration_objects` row, so they cannot be loops. In prod, these mails reach only one log line.

## The big picture

Alfred must answer one question each morning: **what still waits on me, and how do I know?** Three kinds of statements answer it. They come from different places, and they change at different speeds:

| Statement | Example | Who can say it |
| --- | --- | --- |
| A thing is in a state | "PR #12 is merged." | Only the source that owns the thing: a webhook, a poll, a live read, or the service's own mail |
| A thing, or a condition, touches the user | "This Linear mail asks you to review PR #12." | Any source: a mail, a chat message, the user's own act, a todo |
| A loop is open or closed, and why | "Open: the mail of 09:10 asks for review, and GitHub said `open` at 07:00." | Only `verifyLoops`, from the two statements above |

Today, one code path mixes the three statements, once for each provider. This ADR gives each statement its own record and its own writer. Then the provider knowledge has one home: the source declaration.

### An example with nested things

A mail arrives from Linear: "Priya moved ENG-482 to In Review. Linked: github.com/acme/api/pull/12." PR #12 has a failed CI run on its branch.

- The mail is from Linear's own sender. So it is a **fact** for the Linear issue ENG-482: state `In Review`, category `active`.
- The mail names PR #12. Linear does not own the PR, so the mail is not a fact for the PR. It is a **pointer** to the PR, and a pointer to ENG-482.
- Linear says that ENG-482 links to PR #12. That is a fact about a link between two things. GitHub says that PR #12 runs on the CI target `acme/api@feature-x`. So the things form a chain: ENG-482 → PR #12 → the CI target.
- The pointer stores only what the mail names: ENG-482 and PR #12. It does not store the chain, because the chain changes after the mail. `verifyLoops` follows the links when it reads, with a bound of two steps.
- The loop is "review ENG-482". It is open while ENG-482 is `active`. The briefing can say "PR #12 merged, but ENG-482 is still In Review", because the proof names both facts.

This is why a pointer points at the real things and not at the mail: one mail can name more than one thing, a thing can link to other things, and the same thing gets mail from more than one service.

## Decisions

### 1. A source declares what it can tell, as typed data

Each source has one declaration. A built-in source declares it on its `INTEGRATIONS` entry (ADR-0093), so the compiler checks it. A custom MCP server stores a reviewed declaration with the server (ADR-0118 decision 5), and Alfred parses it at the boundary. The key is the `SourceIdentity` of ADR-0118 decision 2. `ObjectStateProvider` is removed.

```ts
interface SourceDecl {
  /** The things that this source owns, and how each one lives and dies. */
  kinds: Record<KindName, KindDecl>;
  /** Whose mail is this source speaking. Only that mail can be a fact (ADR-0120 decision 2). */
  senders?: DomainSet;
  /** Turn one stored receipt into statements. Code for a built-in; a reviewed mapping for MCP. */
  ingest?: Ingest;      // receipt → { facts, acts, pointers }
  /** Read the current state of one thing now. */
  read?: ReadDecl;      // ThingRef → Fact | read_failed
  /** How Alfred proves that the source missed nothing in a window. Absent: always blind. */
  coverage?: CoverageDecl;
}

interface KindDecl {
  preset: "work_item" | "run_on_target" | "custom"; // ADR-0118 decision 5
  lifecycle: ObjectKindDef;                          // closesAskOn, closesAskFrom, absorbing
  identity: IdentityDecl;                            // attributes + the spellings that text can hold
  states: Record<NativeState, StateCategory>;        // replaces each provider `normalize`
}
```

Why this shape:

- **The "what" is data, the "how" is a function, and each one has one place.** A kind, its lifecycle, its identity, and its state map are data that a reader can check without a network call. Only `ingest` and `read` touch a provider, and each one returns the same shapes (decision 2).
- **A custom MCP server fits with no new code.** Its `ingest` and its `read` are reviewed mappings over a read-only tool: a tool, the argument template from the identity, the path to the items, the fields, and the state map. This is the current `mcp_health_mapping` shape, made general. The owner decided on a mapping, not a model read, on 2026-11-07.
- **An identity declares its spellings.** Example: the GitHub pull request identity is `{owner, repo, number}`, and its spellings are the URL `https://github.com/{owner}/{repo}/pull/{number}` and the short form `{owner}/{repo}#{number}`. A spelling is data. It replaces the vendor regexes of `loop-key.ts` and `github-adapter.ts` (decision 3).

### 2. A fact is an event, and the state of a thing is a projection of its facts

A **fact** is one statement from a source: "this thing was in this state at this time". Each webhook, poll, live read, and service mail gives facts. Alfred writes each fact as an `observations` row, and `integration_objects` is a projection of these rows: code can delete the table and build it again from the facts.

```ts
type Fact = {
  thing: ThingRef;               // { source: SourceIdentity, kind, identity }
  nativeState: string;           // the provider's word, for example "merged" or "In Review"
  occurredAt: Date | null;       // the provider's time
  observedAt: Date;              // Alfred's time: the receipt, or the start of the read
  via: "push" | "poll" | "read" | "service_mail" | "migrated";
  evidence: EvidenceRef;         // the receipt, the document, or the read run
  links?: { relation: string; to: ThingRef }[];  // "ENG-482 links to PR #12"
};
```

Why:

- **Today `applyEvent` writes the state, and the evidence is lost.** The row keeps the newest state and its versions, but not who said it or how. Thus "each closure names its writer" cannot be true. With facts as rows, the writer of each version is the fact that made it.
- **One reducer for every source.** The reducer reads the `states` map of the kind and applies the recency guard and the absorbing guard. The eight event types and the four reducers of `store.reduce` go away. Each source's `ingest` and `read` produce `Fact` and nothing else.
- **A fact family is one thing.** It dedups against its head on the native state and the provider time. A repeated read of the same state writes no new fact. The check log (decision 5) records that the read confirmed the state.
- **A fact is also activity.** ADR-0118 decision 1 says that a change of category is an activity row. That row is the fact that changed the category. One row has two readers. It is not two rows.
- **A link between two things is part of a fact.** The projection writes it to `integration_object_relations`, which no code writes today. That table then joins two `integration_objects` rows, not the old `entities` table.

The migration writes one fact for each existing version of each `integration_objects` row, with `via: "migrated"`. Then a replay must give the same rows.

### 3. A pointer says that something touches the user, and any source can write it

A **pointer** is one statement: "this evidence says that this thing, or this condition, touches the user". It is an `observations` family for each piece of evidence. It replaces `gmail/email_interpretation`.

```ts
type Pointer = {
  from: { source: SourceIdentity; evidence: EvidenceRef }; // a mail, a chat turn, an act, a todo
  at: Date;
  targets: PointerTarget[];                                  // one piece of evidence can name many
};

type PointerTarget =
  | { kind: "thing"; role: "subject" | "mentioned"; stance: "opens" | "closes" | "mentions";
      keys: Key[]; links: Link[] }                           // unresolved (ADR-0120 decision 3 stays)
  | { kind: "condition"; stance: "opens"; text: string;      // the user's words
      watch: { from?: Identity; sources?: SourceIdentity[] }; until?: Date };
```

Why each field exists:

- **`targets` is a list, because one mail names many things.** The Linear mail names ENG-482 (`subject`, `opens`) and PR #12 (`mentioned`).
- **The targets stay unresolved.** A pointer stores what the evidence names, not the row that it matched at that time. A row that does not exist yet can match later, and the links of a thing change after the mail.
- **`stance` replaces the triage category as the opener.** Today only a loud mail can open a loop, and no mail can close one. A receipt mail `closes`, and a "you are mentioned" mail `mentions`. The triage label stays the loudness of the mail. It is not the meaning of the mail for the loop.
- **`condition` is the case with no thing.** "Tell me when the landlord replies" is a condition with `watch.from` set to the landlord's identity. "Rotate the Railway credentials" is a condition with `watch.sources` set to Railway.

The writers:

| Source of the pointer | Writer | Example |
| --- | --- | --- |
| Mail | triage, one time for each message | "Review PR #12" |
| Chat | a new `track` tool | "Watch the deploy of api until it is green" |
| The user's own act | the source's `ingest` | The user opened PR #12, or a person asked the user to review it |
| Todo | the todo's `sources` | A todo about ENG-482 |

**At triage, the classifier states the targets (owner decision, 2026-11-07).** The classifier reads the mail already. It gives each target as a source, a kind, the identity values, a role, and a stance. Code keeps a target only when the source declares the kind and one declared spelling of the identity occurs in the text (ADR-0109 rule 2: "no grounding, no row"). Thus a Linear, Sentry, or ClickUp mail gets real targets with no vendor grammar. The vendor regexes go away after a back-test on the prod mail of the last 30 days shows that the classifier finds the same targets.

### 4. A loop is a view of what pointers hold open; it is not a work item

A **loop** is one thing or one condition that at least one `opens` pointer names, and that no later fact or event has closed. The loop has no table. `verifyLoops` derives it from pointers and facts on each run.

A **work item** is the glossary word for a piece of work that the user can see and change, with a status. Today the only work item is a todo. A loop is not a work item (owner decision, 2026-11-07): Alfred derives a loop, and the user does not edit it. A todo is one source of pointers. When the user marks a todo done, that closes the todo, never the thing (ADR-0120 decision 5.4).

The **`LoopKey`** names a loop: the `ThingRef` of its subject thing, or the family key of its condition pointer. It goes on every row, every log line, and the Langfuse span of a loop.

The loop set is bounded as ADR-0120 decision 4 says, with one change. A loop enters the set when an `opens` pointer from any source is in the window, or when a pointer has no end (an open todo, or a condition before its `until`). The triage category no longer decides.

### 5. Each verdict carries its proof, and a check log records each change

`verifyLoops` has four steps. Only the third step touches the network.

```
select(pointers, now)                       → Loop[]
decide(loop, facts, coverage, now)          → Verdict | Need[]    // pure
run each Need inside the run budget:
    a thing      → source.read(thing)       → Fact
    a condition  → match(condition, events) → MatchedEvent
commit the facts in one transaction (ADR-0120 decision 7 stays)
decide(...) again, with the new facts       → LoopProof
append the proof to the check log
```

```ts
type LoopProof = {
  loop: LoopKey;
  verdict: "open" | "closed" | "unverified";
  openedBy: [PointerRef, ...PointerRef[]];
  because: [Cause, ...Cause[]];
  checkedAt: Date;
  runId: string;
};

type Cause =
  | { kind: "fact"; fact: FactRef; via: Fact["via"] }
  | { kind: "ambiguous"; case: "mail_newer" | "source_blind" | "no_row" }  // ADR-0120 decision 5
  | { kind: "read_failed"; reason: "no_reader" | "no_target" | "over_cap" | "fault" | "refused" }
  | { kind: "matched_event"; event: EventRef; rationale: string; cited: string[] }
  | { kind: "no_thing"; target: PointerTarget }     // the pointer named nothing that resolves
  | { kind: "user_word"; pointer: PointerRef };
```

The rules:

1. **No verdict without a cause.** The type holds at least one cause.
2. **Each closure names its writer.** A `closed` verdict cites a fact or a matched event.
3. **Absence is a cause.** A pointer that resolves to nothing gives `no_thing`, not silence. The Vercel and security mails of today get a visible cause.
4. **`decide` is pure.** Its input is ids of stored rows. Anyone can replay a verdict from the check log.
5. **One `LoopKey` everywhere.**

**A matched event may close a condition loop (owner decision, 2026-11-07).** The matcher is a cheap model. It reads the events after the pointer that fit `watch`, and it must cite the event and the text that matched (ADR-0109 rule 3). Code checks each citation against the stored event. The proof keeps the rationale, and the briefing shows it in one line. A matched event closes the condition pointer only. It never sets the state of a thing.

**The check log is an observation family for each `LoopKey`, with `dedup: "head"` on the verdict and the cause ids.** It records only the changes. A run that changes nothing writes nothing for that loop. The `loop_verification_runs` row stays as the run record: its id is the `runId`, and its window rule stays.

### 6. The gather is one function over generic readers

```
gatherBriefing(user, window) = {
  mail:     readMail(window),            // the triage buckets
  calendar: readCalendar(window),
  place:    readPlace(),                 // weather and official warnings
  activity: readActivity(window),        // acts, including category changes
  loops:    verifyLoops(window),         // LoopProof[]
  coverage: readCoverage(window),        // one entry for each source
}
```

What goes away:

- **`deploy_status`.** A failed deploy that no mail reported is an act of its source (ADR-0120 decision 10 stays).
- **`github_merged`.** The GitHub merged read becomes the `coverage` declaration of GitHub, which is its silence proof.
- **The verified pulls and the MCP health fold.** They become `source.read`, and `verifyLoops` calls it.
- **The GitHub fallback of day shape.** Day shape counts activity.

The provenance of each input comes from `coverage`, so the gather adds no provenance by hand. The composer gets `list_loops`, which returns `LoopProof[]`. The words of each verdict come from its causes.

### 7. Code Mode gets the same steps

ADR-0120 decision 9 stays, on the new types. `loops.open()` gives the loop set. `loops.verify()` runs the reads and gives the facts. `loops.commit()` writes the facts. A script can commit only a fact that a `read` returned.

## Implementation slices

Each slice keeps the product working. The order is a strangler, not a big-bang rewrite.

1. **Source declarations, no change in behavior.** Put `kinds`, `senders`, `read`, and `coverage` on the `INTEGRATIONS` entries. Add the `SourceIdentity` columns to `integration_objects` and `observations` (ADR-0118 decision 2). Remove `ObjectStateProvider`. Make the registry entries for Railway and Vercel tell the truth.
2. **Facts.** Each `ingest` and `read` gives `Fact`. Write the fact rows, make `integration_objects` a projection, and migrate each existing version to a fact. Prove that a replay gives the same rows.
3. **Pointers.** Write pointer rows at triage from the current keys and links. Backfill them from `email_interpretation`, and make todos a pointer source. Remove `email_interpretation`.
4. **`verifyLoops` with proof.** Add the pure `decide`, `LoopProof`, and the check log. Make the source reads the needs. Move the verified pulls and the MCP health read into `source.read` as mappings. `list_loops` returns proofs.
5. **One gather.** Remove `deploy_status` and `github_merged`. Count day shape from activity. Remove the `#1684` lint carve-outs in `briefings/`.
6. **The classifier states the targets.** Add the containment check and the back-test. Then remove the vendor regexes in `loop-key.ts` and `github-adapter.ts`.
7. **Conditions.** Add the chat `track` tool, condition pointers, and the matcher.
8. **Code Mode.** Add the host functions of decision 7.

## Where this touches the rest of the app

| Area | Change |
| --- | --- |
| `@alfred/contracts` | Remove `OBJECT_STATE_PROVIDERS`. Move `INTEGRATION_OBJECT_DEFS` into the source `kinds`. Collapse `LOOP_ENTITY_PROVIDERS`, `TRACKER_SENDER_PATTERNS`, and `MCP_HEALTH_IDENTITY_PROVIDERS`. Remove `deploy_status` and `github_merged` from `GATHER_INPUTS`. `BriefingLoop` becomes `LoopProof`. `TodoObjectRef` and `evidenceObjectClosesAsk` use `ThingRef`. |
| Database | Add the source columns to `integration_objects` and `observations`. The MCP rows stop packing the connection id in `externalId`. Add the fact, pointer, and loop-check observation kinds. Repoint `integration_object_relations` at `integration_objects`. |
| Object state | The 8-member event union and the 4 reducers become `ingest` parsers and one reducer. `OBJECT_STATE_ADAPTERS`, `VERIFIED_PULLS`, and `LOOP_VERIFIERS` go away. The GitHub backfill script changes. |
| Activity (ADR-0118) | `OBSERVATION_REDUCERS`, `ACTIVITY_SOURCES`, and `SilenceEvidence` merge into the source declaration. Coverage no longer needs an inbound webhook source. |
| Triage | `object-links.ts` becomes the pointer writer. The classify output gets targets. The todo object comes from the pointer. `runEmailTriageCloseLoopTodos` stops closing todos on the `payment` label. |
| MCP | The health mapping becomes a general read and ingest mapping, with the presets of ADR-0118 decision 5. |
| Briefing | `gather.ts`, `provenance.ts`, `list_loops`, the composer prose, `read.ts` `deriveLoopKey`, `open-ask-guard.ts`, and day shape. |
| Chat | The new `track` tool. |
| Context Search | `object-state-source.ts`, `documents-source.ts`, and `object-ref.ts` use `ThingRef`. |

## Preserved behavior

- Absence never closes a loop (ADR-0048 decision D). A failed read gives `unverified`.
- Only a fact from the source that owns a thing sets the state of that thing (ADR-0062, ADR-0120 decision 2). A matched event, a todo, and a chat message close a pointer, never a thing.
- A custom MCP source cannot override the verdict of a built-in source.
- The triage tag path reads no activity and no embeddings (ADR-0113). The classifier states targets from the mail text only.
- Reads run outside the transaction, and one transaction writes the facts of a run (ADR-0120 decision 7).
- Postgres stays the only store (ADR-0058).

## Residual risk

- **The classifier can miss a target.** The containment check stops a false target, not a missed one. The back-test of slice 6 measures the misses before the regexes go.
- **A matched event can close a condition loop by mistake.** The proof shows the rationale and the cited text, so the owner can see it. A new `opens` pointer opens the loop again.
- **The projection migration is large.** Each version of each row becomes a fact. A replay that does not give the same rows blocks slice 2.
- **A two-step link walk can miss a deeper chain.** The bound keeps the reads small. A longer chain needs a new decision.
- **A source with no `coverage` is always blind.** Each of its things needs a live read when its state is old, so the run cap limits these sources first.

## Rejected alternatives

- **(a) Keep the provider tables and add a registry for the gather only.** It moves the provider lists to a new file, and the lists still disagree.
- **(b) A `loops` table.** It copies the thing and the pointers, and its state would come from inference (ADR-0120 alternative (a)).
- **(c) Store the resolved row in the pointer.** The row can change after the mail, and a thing with no row at triage time could never match.
- **(d) Keep `integration_objects` written in place, with a separate fact log.** Two records of one state can disagree, and nothing proves that the log is complete.
- **(e) A model live read for custom MCP sources.** A reviewed mapping is repeatable and costs no model call. The ADR-0109 model read stays only for soft edges.
- **(f) Make each loop a todo.** The user would see and edit a record that Alfred derives. A todo stays the work item, and it is one source of pointers.
