# ADR-0122 — Each source declares what it can tell, a state is a projection of facts, a pointer says what touches the user, and each loop verdict carries its proof

**Status.** Proposed; not built. Decided with the owner on 2026-11-07. Supersedes ADR-0120 decisions 1, 3, 4, 6, 8, and 9. It keeps ADR-0120 decisions 2, 5, 7, and 10. Amends ADR-0062 (a provider becomes a source, and the state table becomes a projection), ADR-0092 (any source can write an `about` link, not only the mail classifier), ADR-0093 (an integration entry declares what it can tell), ADR-0118 (builds decision 2, and uses the presets of decision 5 for every source), ADR-0109 (rule 2 becomes the one link rule; rule 3 stays for soft edges only), and ADR-0048 (the loop verdict is stored, with its proof). **Amended 2026-11-08 (owner decision):** decision 1a replaces the list of senders with a DMARC-authenticated domain that Alfred learns from confirmed claims, and decision 1 pins each MCP mapping to the shape of its tool. This also amends ADR-0120 decision 2: the sender gate of a service mail is decision 1a. Decision 3a adds one typed writer for pointers, with types from the identity schema of each kind. Decision 3b adds open things: a target of a kind that no source declares keeps its pointer, and no connection is needed.

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
  /** Seed domains whose signed mail can be a fact (decision 1a). Learned domains extend it. */
  mail?: { domains: RegistrableDomain[] };
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
- **A mapping is pinned to the shape of its tool.** The tool of a custom MCP server can change. Each mapping stores the `descriptorHash` of its tool, as `mcp_health_mapping` does today, and runs only while the current catalog has the same hash. When the hash changes, the read gives `read_failed` with the reason `mapping_stale` (decision 5). Thus a changed tool gives `unverified` with a visible cause, never a wrong state. To repair the mapping, a model writes a new mapping from the new tool schema. Alfred runs the new mapping on a thing that has a confirmed fact. If the result is the same state, Alfred uses the new mapping with no confirmation. If not, Alfred asks the owner.
- **An identity declares its spellings.** Example: the GitHub pull request identity is `{owner, repo, number}`, and its spellings are the URL `https://github.com/{owner}/{repo}/pull/{number}` and the short form `{owner}/{repo}#{number}`. A spelling is data. It replaces the vendor regexes of `loop-key.ts` and `github-adapter.ts` (decision 3).

### 1a. A mail is a fact only when its domain is authenticated, and Alfred learns new domains from confirmed claims

Amended with the owner on 2026-11-08. A list of sender addresses goes stale: a vendor adds addresses, sends from subdomains, and moves domains. Nobody knows all the official addresses in advance.

A mail is a fact (`via: "service_mail"`) only when both checks pass:

1. **Gmail reports `dmarc=pass`, and the From domain is under a domain of the source.** DMARC is the check that the domain in the From address is the domain that signed or sent the mail. Gmail writes the result in the `Authentication-Results` header. A domain of the source is a seed domain from `mail.domains` or a learned domain. A subdomain of either domain also passes.
2. **The mail names a thing of a kind that the source declares**, with a declared spelling of its identity (decision 3).

A mail that fails a check is not lost. It becomes a pointer, and the target can carry the state that the mail claims (decision 3).

Why:

- **A missed domain is safe, and a wrong domain is not.** A missed official mail becomes a pointer. The loop still opens, and `verifyLoops` gets the state from `source.read`, or gives `unverified` with a cause. A wrong mail that passes can close a loop with a false state. Thus this check gives precision, and reads and learned domains give coverage.
- **One domain covers all the addresses of a vendor.** `linear.app` covers `notifications@linear.app`, `noreply@linear.app`, and `mail.linear.app` with no list of addresses.
- **DMARC, not DKIM alone.** DKIM is the signature of a domain on the mail. It can pass for the shared domain of a mail provider, for example `sendgrid.net`, that thousands of senders use. DMARC passes only when the signature or the sender agrees with the From domain.
- **A relay cannot pass as the vendor.** This closes the ADR-0120 residual risk "a relay that copies the domain of the service could set a state".
- **The data is already stored.** Ingest gets each message with `format: "full"` and stores it as `raw` (`connections/ingestion/gmail-ingest.ts`). That message holds the `Authentication-Results` header. No code reads the header today.

**Alfred learns a new domain with no confirmation from the owner (owner decision, 2026-11-08).**

- **A claim.** A mail with `dmarc=pass` from a domain that the source does not have can still name a thing of the source and state its native state. The pointer target keeps that state as `claims`.
- **A confirmation.** `verifyLoops` reads the thing. The read confirms the claim when it gives the claimed state, and the provider time of that state is not after the mail.
- **A conflict.** The read gives another state, and the provider time of that state is before the mail. The mail claimed a state that the thing did not have.
- **Learn.** After 3 confirmations on at least 2 different things, with no conflict, Alfred records the domain as learned for that source. The record is an observation family for each source and domain, with `dedup: "head"`. Its head is `learned` or `revoked`, and it cites the facts that confirmed or conflicted.
- **Revoke.** One conflict revokes the domain. To learn it again, the domain needs 3 new confirmations after the revocation. A revocation deletes no fact. A newer read wins over an old mail fact through the recency guard of decision 2.
- **A source with no `read` cannot learn.** For a thing that only mail tracks (ADR-0120 decision 2, the Voyage AI case), the authenticated From domain is the source. That source needs no list of domains.

Each mail fact records the domain that passed and the basis of that domain (`seed` or `learned`). Thus a `LoopProof` can show "closed by a mail from `linear.app` (learned on 11-12)".

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
      keys: Key[]; links: Link[];                            // unresolved (ADR-0120 decision 3 stays)
      claims?: NativeState }                                 // the state the evidence states (decision 1a)
  | { kind: "condition"; stance: "opens"; text: string;      // the user's words
      watch: { from?: Identity; sources?: SourceIdentity[] }; until?: Date };
```

Why each field exists:

- **`targets` is a list, because one mail names many things.** The Linear mail names ENG-482 (`subject`, `opens`) and PR #12 (`mentioned`).
- **The targets stay unresolved.** A pointer stores what the evidence names, not the row that it matched at that time. A row that does not exist yet can match later, and the links of a thing change after the mail.
- **`claims` keeps what a mail says that is not yet a fact.** A mail that fails the check of decision 1a can still state "ENG-482 is In Review". The claim never sets a state. `verifyLoops` compares it with a read, and the result confirms or conflicts with the domain of the mail (decision 1a).
- **`stance` replaces the triage category as the opener.** Today only a loud mail can open a loop, and no mail can close one. A receipt mail `closes`, and a "you are mentioned" mail `mentions`. The triage label stays the loudness of the mail. It is not the meaning of the mail for the loop.
- **`condition` is the case with no thing.** "Tell me when the landlord replies" is a condition with `watch.from` set to the landlord's identity. "Rotate the Railway credentials" is a condition with `watch.sources` set to Railway.

The writers:

| Source of the pointer | Writer | Example |
| --- | --- | --- |
| Mail | triage, one time for each message | "Review PR #12" |
| Chat | a new `track` tool | "Watch the deploy of api until it is green" |
| The user's own act | the source's `ingest` | The user opened PR #12, or a person asked the user to review it |
| Todo | the todo's `sources` | A todo about ENG-482 |

**At triage, the classifier states the targets (owner decision, 2026-11-07).** The classifier reads the mail already. It gives each target as a source, a kind, the identity values, a role, and a stance. Code keeps a target only when it is grounded (ADR-0109 rule 2: "no grounding, no row"). For a declared kind, one declared spelling of the identity must occur in the text. For a kind that no source declares, the target is an open thing, and each identity value must occur in the text (decision 3b). Thus a Linear, Sentry, or ClickUp mail gets real targets with no vendor grammar. The vendor regexes go away after a back-test on the prod mail of the last 30 days shows that the classifier finds the same targets.

### 3a. One typed writer for pointers, with types from the source declaration

Amended with the owner on 2026-11-08. Four writers make pointers (decision 3). Each writer must not spell a thing or a key in its own way. Thus one function writes every pointer, and its types come from the declarations of decision 1.

**The identity of a kind is a zod schema.** Today the kinds in `INTEGRATION_OBJECT_DEFS` have a lifecycle, but no typed identity. Slice 1 adds it:

```ts
github: { source: { kinds: {
  pull_request: {
    identity: {
      schema: z.object({ owner: z.string(), repo: z.string(), number: z.number().int() }),
      spellings: ["https://github.com/{owner}/{repo}/pull/{number}", "{owner}/{repo}#{number}"],
    },
    // lifecycle, states (decision 1)
  },
}}}
```

**The types and the parsers come from that schema.** No writer declares a second interface:

```ts
type IdentityOf<S, K> = z.infer<Sources[S]["kinds"][K]["identity"]["schema"]>;

// One arm for each pair of a source and a kind. A check on `source` and `kind` narrows `identity`.
type BuiltInThingRef = { [S in BuiltInSource]:
  { [K in KindOf<S>]: { source: S; kind: K; identity: IdentityOf<S, K> } }[KindOf<S>] }[BuiltInSource];
type ThingRef = BuiltInThingRef | McpThingRef | OpenThingRef;   // OpenThingRef: decision 3b

const thingRefSchema = /* the same union as a zod discriminated union, built from the registry */;

thing("github", "pull_request", { owner: "acme", repo: "api", number: 12 }); // compiles
thing("github", "pull_request", { id: 12 });   // compile error: not the declared identity
thing("github", "issue", { key: "X-1" });      // compile error: GitHub declares no `issue`
```

`thingKey(ref)` is the only function that builds the key of a thing and a `LoopKey`. It reads the attributes in their declared order. No writer spells a key by hand.

**Three routes, one writer.** The proof is different for each route, because the trust is different:

| Route | Writers | What proves the target |
| --- | --- | --- |
| Code | own-act `ingest`, todo `sources` | The compiler. Code builds the `ThingRef`. |
| Model | triage classifier, chat `track` | The model output schema is `thingRefSchema`. After the parse, a grounding step must pass. |
| Custom MCP | the MCP `ingest` mapping | A zod schema that Alfred builds at run time from the reviewed mapping, and parses at the boundary. |
| No declaration | triage classifier, chat `track` | An `OpenThingRef`. Each identity value must occur in the text (decision 3b). |

**A brand makes grounding a required step.** A brand is a type tag that only one function can add. Only the two grounding functions return a `Grounded` target:

```ts
type Grounded<T> = T & { readonly [grounded]: "text" | "read" };

groundInText(text: string, target: PointerTarget): Grounded<PointerTarget> | null;
// a declared spelling of the identity occurs in the evidence (ADR-0109 rule 2)
groundByRead(target: PointerTarget): Promise<Grounded<PointerTarget> | null>;
// `source.read` finds the thing; for chat, where the words name no spelling
```

```ts
writePointer<E extends EvidenceKind>(p: {
  from: EvidenceRef<E>;               // "mail" | "chat" | "act" | "todo"
  at: Date;
  targets: NonEmpty<TargetFor<E>>;    // mail and chat: Grounded<PointerTarget>; act and todo: PointerTarget
}): Promise<PointerRef>;
```

- A triage call that skips the grounding step does not compile.
- `writePointer` builds the family key from the evidence, for example `pointer:gmail:<messageId>`. It writes through `appendObservationFamilyMember` with `dedup: "head"`.
- A target that fails grounding is dropped. If no target is left, the writer still records the evidence with an empty target list. Thus `verifyLoops` gives the cause `no_thing`, and the drop is visible.

Example, the Linear mail:

```ts
const out = classifierOutputSchema.parse(raw);   // targets: ThingRef[] from the model
const targets = out.targets.flatMap((t) => groundInText(mail.text, t) ?? []);
// ENG-482 passes (spelling "{key}"). acme/api#12 passes (the URL is in the mail).
// An invented github/pull_request #13 returns null and is dropped.
await writePointer({ from: { kind: "mail", id: messageId }, at: mail.date, targets });
```

**The read side fails closed.** `verifyLoops` parses each stored pointer with `pointerSchema`, which comes from the same registry. A target that the current schema rejects gives the cause `no_thing`, not an error. This target can come from an older deploy, or from an MCP mapping that changed (decision 1). One bad target never stops the read of the other targets.

Why:

- **One declaration, one place to change.** A new kind or a new identity field changes the declaration only. Then the compiler finds each writer that builds the old shape.
- **The compiler proves the shape, and the brand proves the order of steps.** Neither one proves that the model chose the right thing. The grounding check proves that the thing occurs in the evidence, and the back-test of slice 6 measures the misses.
- **An MCP source and an undeclared source stay open.** Their identity is `Record<string, string | number>` after the parse, because no compiler sees a declaration for them. A built-in source never has this weaker arm. No arm needs a connection (decision 3b).

### 3b. A thing with no declaration is an open thing, and no connection is needed

Amended with the owner on 2026-11-08. A mail can name a thing of a service that Alfred has no integration for, for example a Jira mail about `PROJ-91`. A pointer must not depend on a connection or on an MCP client. A declaration only adds better types and a `read`. Without a declaration, the pointer still exists, and the loop still opens.

```ts
type ThingRef = DeclaredThingRef | OpenThingRef;  // DeclaredThingRef: built-in sources and reviewed MCP mappings

type OpenThingRef = {
  source: { domain: RegistrableDomain };   // the authenticated From domain, or the domain of a URL in the text
  kind: OpenKind;                          // a closed list, see below
  identity: Record<string, string | number>;
};

const OPEN_KINDS = ["issue", "pull_request", "deploy", "payment", "alert", "order", "other"] as const;
```

The rules:

- **Grounding is stricter for an open thing.** No declared spelling exists. Thus each identity value must occur exactly as written in the evidence text: `PROJ-91` must be in the mail. `groundInText` applies this rule to an `OpenThingRef`.
- **The open kind is a closed list.** The kind is part of the key of the thing. If the model chose a free word, one thing could get two keys, for example `issue` and `ticket`, and give two loops. The list is short. `other` is the fallback.
- **The source of an open thing is a domain.** It comes from the authenticated From domain (decision 1a) when the mail is from the service. Otherwise it comes from the domain of a URL in the text that holds an identity value. With no such domain, the target is dropped.
- **A mail fact about an open thing needs a category.** No `states` map exists. Thus the classifier states the category (`active`, `resolved`, `failed`, or `abandoned`) together with the native word. A mail with `dmarc=pass` from the domain of the thing is a fact (decision 1a), because that domain is the source. Any other mail gives a pointer with `claims`.
- **An open thing has no `read`.** Its verdict comes from mail facts, or it is `unverified` with the cause `read_failed: no_reader`.
- **`thingKey` handles both arms.** For an open thing, the key is the domain, the kind, and the identity values in sorted order of their names.
- **A later declaration needs no migration.** Pointers keep their targets unresolved (decision 3). When a declaration appears for the domain, for example after the owner connects Jira, `verifyLoops` maps the open ref to the declared kind when it reads. It uses the `mail.domains` of the source and the identity schema of the kind. Old pointers then resolve with no backfill. An open ref that does not parse against the declared schema stays open.

Why:

- **No source is first class for the pointer.** The owner does not connect every service that sends mail. A connection adds a read and better types, but the question "does this touch me?" comes from the evidence, not from the connection.
- **One rule for every source.** A built-in source, a custom MCP server, and an unknown service all go through the same writer, the same grounding, and the same `thingKey`. Only the strength of the proof changes.

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
  | { kind: "read_failed"; reason: "no_reader" | "no_target" | "over_cap" | "fault" | "refused" | "mapping_stale" }
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

1. **Source declarations, no change in behavior.** Put `kinds`, `mail.domains`, `read`, and `coverage` on the `INTEGRATIONS` entries. Give each kind its identity schema and spellings, and derive `ThingRef`, `thingRefSchema`, and `thingKey` from them (decision 3a). Add the `SourceIdentity` columns to `integration_objects` and `observations` (ADR-0118 decision 2). Remove `ObjectStateProvider`. Make the registry entries for Railway and Vercel tell the truth.
2. **Facts.** Each `ingest` and `read` gives `Fact`. Write the fact rows, make `integration_objects` a projection, and migrate each existing version to a fact. Prove that a replay gives the same rows. Parse the `Authentication-Results` header at the Gmail ingest boundary into the document metadata, and backfill it from the stored `raw` message. A service mail is a fact only with `dmarc=pass` for a seed domain (decision 1a).
3. **Pointers.** Add `writePointer`, `groundInText`, `groundByRead`, and `pointerSchema` (decision 3a), with the open arm and `OPEN_KINDS` (decision 3b). Write pointer rows at triage from the current keys and links. Backfill them from `email_interpretation`, and make todos a pointer source. Remove `email_interpretation`.
4. **`verifyLoops` with proof.** Add the pure `decide`, `LoopProof`, and the check log. Make the source reads the needs. Move the verified pulls and the MCP health read into `source.read` as mappings. `list_loops` returns proofs.
5. **One gather.** Remove `deploy_status` and `github_merged`. Count day shape from activity. Remove the `#1684` lint carve-outs in `briefings/`.
6. **The classifier states the targets.** The output schema is `thingRefSchema`, and `groundInText` is the containment check. Add the back-test. Then remove the vendor regexes in `loop-key.ts` and `github-adapter.ts`. Add `claims` to the targets, and add the domain observations that `verifyLoops` learns and revokes (decision 1a). Add the open targets and their stated category, and the read-time mapping of an open ref to a declared kind (decision 3b).
7. **Conditions.** Add the chat `track` tool, condition pointers, and the matcher.
8. **Code Mode.** Add the host functions of decision 7.

## Where this touches the rest of the app

| Area | Change |
| --- | --- |
| `@alfred/contracts` | Remove `OBJECT_STATE_PROVIDERS`. Move `INTEGRATION_OBJECT_DEFS` into the source `kinds`. Collapse `LOOP_ENTITY_PROVIDERS`, `TRACKER_SENDER_PATTERNS`, and `MCP_HEALTH_IDENTITY_PROVIDERS`. Remove `deploy_status` and `github_merged` from `GATHER_INPUTS`. `BriefingLoop` becomes `LoopProof`. `TodoObjectRef` and `evidenceObjectClosesAsk` use `ThingRef`. |
| Database | Add the source columns to `integration_objects` and `observations`. The MCP rows stop packing the connection id in `externalId`. Add the fact, pointer, and loop-check observation kinds. Repoint `integration_object_relations` at `integration_objects`. |
| Object state | The 8-member event union and the 4 reducers become `ingest` parsers and one reducer. `OBJECT_STATE_ADAPTERS`, `VERIFIED_PULLS`, and `LOOP_VERIFIERS` go away. The GitHub backfill script changes. |
| Activity (ADR-0118) | `OBSERVATION_REDUCERS`, `ACTIVITY_SOURCES`, and `SilenceEvidence` merge into the source declaration. Coverage no longer needs an inbound webhook source. |
| Gmail ingest | Parse the `Authentication-Results` header into the document metadata (decision 1a). No code reads it today. |
| Triage | `object-links.ts` becomes the pointer writer. The classify output gets targets. The todo object comes from the pointer. `runEmailTriageCloseLoopTodos` stops closing todos on the `payment` label. |
| MCP | The health mapping becomes a general read and ingest mapping, with the presets of ADR-0118 decision 5. Each mapping stays pinned to the `descriptorHash` of its tool. A changed tool gives `mapping_stale`, and a new mapping that a model writes is used only when it gives the same state for a thing with a confirmed fact (decision 1). |
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

- **The model can give one open thing two kinds.** The closed list `OPEN_KINDS` limits this, but `issue` and `other` can still split one thing. The back-test of slice 6 counts the splits.
- **A stated category for an open thing comes from a model.** Only a mail from the authenticated domain of the thing makes it a fact. A wrong category from that mail can close a loop. A later mail from the same domain corrects it through the recency guard.

- **A spelling can match by chance.** A short spelling, for example `{key}` for a Linear issue, can occur in text that is not about the thing. The grounding step proves presence in the text, not meaning. The back-test of slice 6 measures this.
- **The type of a derived union can grow large.** One arm for each pair of a source and a kind can slow the compiler. If it does, the writer can take the arms of one source at a time.

- **The classifier can miss a target.** The containment check stops a false target, not a missed one. The back-test of slice 6 measures the misses before the regexes go.
- **A matched event can close a condition loop by mistake.** The proof shows the rationale and the cited text, so the owner can see it. A new `opens` pointer opens the loop again.
- **The projection migration is large.** Each version of each row becomes a fact. A replay that does not give the same rows blocks slice 2.
- **A two-step link walk can miss a deeper chain.** The bound keeps the reads small. A longer chain needs a new decision.
- **A vendor without DMARC gives no mail facts.** Some vendors publish no DMARC record, or sign only with the domain of their mail provider. Their mail stays a pointer, and their things need reads. This is the safe direction.
- **A learned domain can rest on weak proof.** A domain that claims only the common state, for example `open`, gets confirmations easily. The rule of 2 different things limits this, and one conflict revokes the domain. A newer read always wins over a mail fact.
- **A repaired MCP mapping is checked on one thing only.** A new mapping can give the right state for that thing and a wrong state for another. The next conflict with a mail claim or a newer read shows it.
- **A source with no `coverage` is always blind.** Each of its things needs a live read when its state is old, so the run cap limits these sources first.

## Rejected alternatives

- **(a) Keep the provider tables and add a registry for the gather only.** It moves the provider lists to a new file, and the lists still disagree.
- **(b) A `loops` table.** It copies the thing and the pointers, and its state would come from inference (ADR-0120 alternative (a)).
- **(c) Store the resolved row in the pointer.** The row can change after the mail, and a thing with no row at triage time could never match.
- **(d) Keep `integration_objects` written in place, with a separate fact log.** Two records of one state can disagree, and nothing proves that the log is complete.
- **(e) A model live read for custom MCP sources.** A reviewed mapping is repeatable and costs no model call. The ADR-0109 model read stays only for soft edges.
- **(f) Make each loop a todo.** The user would see and edit a record that Alfred derives. A todo stays the work item, and it is one source of pointers.
- **(g) A list of official sender addresses for each source.** Nobody knows all the addresses in advance, and they change. The list also lets a relay that copies an address pass (decision 1a).
- **(h) The owner confirms each learned domain.** The owner chose autonomous learning on 2026-11-08. The proof of each learned domain is stored, and one conflict revokes it.
- **(i) A hand-written identity type for each source, or a string key.** A second type drifts from the declaration, and a string key lets each writer spell it in its own way. Decision 3a derives both from one schema.
- **(j) Keep only the targets of declared kinds.** A mail from a service that the owner did not connect would open no loop. The owner decided on 2026-11-08 that a pointer must not depend on a connection (decision 3b).
- **(k) A free word for the open kind.** One thing could get two keys and give two loops. A closed list is the cost of one key.
