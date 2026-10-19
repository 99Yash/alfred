# Structural review — looking above and below the diff

[review-checklist.md](./review-checklist.md) is the **surface sweep**: a bounded list of review rules for the code in the diff. This doc covers the two open directions that the sweep cannot reach. Look **up** from the changed lines to ask whether the code has the correct shape. Drill **down** through them to ask whether the claimed behavior survives every relevant path, state and failure.

The worked examples for this method are in [structural-review-exemplars.md](./structural-review-exemplars.md). Read them when a section here is not clear enough to apply.

## Three review motions

- **Surface is rule-guided verification.** Sweep the changed code against [review-checklist.md](./review-checklist.md). The gates in [enforced-rules.md](./enforced-rules.md) already ran, so do not repeat them. The prompts are known, so the work is bounded and repeatable.
- **Up is structural search.** Infer a better domain shape that is not present yet, then measure the code against it. The target is unknown, so the work is generative.
- **Down is invariant proof.** Start with a behavior that the change claims. Trace it through callers, state transitions, persistence, consumers, time and failure. Continue until the relevant paths preserve it or a counterexample breaks it.

Each motion needs a different tool. Verification uses a list. Up uses a heuristic: _which shape is missing, and how do we score it?_ Down uses falsification: _which invariant is claimed, and which sequence breaks it?_

**Fund up first, and earn down selectively.** Run the structural search before the rule sweep, so that familiar prompts do not anchor the review. Then spend the expensive down-depth on risky claims and candidate structures.

The two open directions support each other:

- **Up without down gives elegant incompleteness.** A registry can centralize a shape and still mishandle legacy persisted data.
- **Down without up gives serial patches.** A reviewer closes retries, stale state and partial failure one at a time, and misses the absent boundary that keeps making the class.
- **The loop is the method.** Discover up, prove down. When the proof finds several sibling failures, look up again for the missing structure. Then trace the proposed structure down again.

## What a structural defect is

A structural defect is **drift between the structure of the code and the structure of the domain**. The code splits one thing, fuses two things, or claims a shape that it does not enforce.

> A structural defect shows itself when one domain change requires multiple coordinated edits and nothing makes that coordination inevitable.

"Nothing makes it inevitable" is a gradient. The [enforcement tiers](./gate-design.md#enforcement-tiers) measure how strongly a mechanism holds the edits together.

Drift can cause damage before it forces a second edit. Three revealers, from the most objective to the earliest:

1. **Multiple coordinated edits.** The change touches N places, and nothing enforces consistency.
2. **Unsafe extension.** You can add the next case, but nothing guides you. You can forget the default.
3. **Comprehension obstruction.** A reader cannot recover the domain shape from the code shape. [Required knowledge](#required-knowledge) gives this revealer a count.

Lead with the most objective revealer that applies to the case.

## Breadth discovers; depth proves

Discovery is breadth-first. Depth must be earned. A deep read confirms a structural smell and tries to break a behavioral claim. It does not discover missing structure by itself.

- **Pass 1 — orient.** Recover the intent of the change, its claimed invariants, the affected domain facts, and the trust boundaries.
  - **Check the premise against data before code.** A factual premise in an issue, plan or PR body is a claim. Settle it with a query, a log or `git log`, and cite the result.
- **Pass 2 — wide, shallow, cheap (up-discovery).** Map where each fact, operation and shape lives, and count its homes. Collect candidate smells. Do not read every function deeply.
- **Pass 3 — bounded surface sweep.** Apply the review checklist to the authored changed code. Compare each generated artifact with its source.
- **Pass 4 — deep, only where earned (down-proof).** Trace the risky invariants and candidate restructures through callers, state, dependencies and failure modes. Try to falsify them with concrete sequences.

### Review sources, reconcile artifacts

Classify the diff before you review it:

- **Authored sources** (application code, schemas, configuration, contracts, hand-written migrations and scripts) get the surface sweep, join the up-map, and can earn down-depth.
- **Generated artifacts** (lockfiles, generated SQL, snapshots, generated clients, build output) get no style review and no redesign. Compare each one with its source and the intended delta. Did the package resolve to the expected version? Did the schema generation emit only the intended operations?
- **External internals** (dependency source, framework internals, database or provider behavior) are not part of the routine surface. Read them only when the invariant depends on behavior that public contracts, types and focused probes do not establish.

A generated file becomes evidence when its delta is surprising or has a high consequence. Examples: an unexpected lockfile source, or a destructive or reordered operation in generated SQL.

## Map the domain before judging the structure

The six axes below classify **how** code disagrees with the domain. They do not tell you **which** domain structure to recover. Start the up-pass with an obligation: what must always stay true (safety), what must eventually become true (liveness), and what must never occur. Then map the dimensions that can make or break it.

| Dimension | What to recover from the domain |
| --- | --- |
| **Identity** | What persists through change? What counts as the same entity, attempt, message, value or relationship? |
| **Authority** | Who may decide, mutate, validate and enforce each rule, and over what scope? |
| **Lifecycle / state** | Which states, events, guards, terminal outcomes and recovery transitions are legal? |
| **Consistency / coordination** | Which observations or changes must agree? What atomicity, isolation, ordering, locking or compensation holds them together? |
| **Time / order** | Which claims depend on causality, freshness, deadlines, leases, expiry, schedules or wall-clock time? |
| **Effects / resources** | What is read, written, emitted, consumed, reserved, billed, retried, cancelled, acquired or released? Which effects are irreversible? |
| **Representation** | Which domain, wire, storage and UI encodings exist? Which distinctions and invalid states do they keep or erase? Where are values parsed? |
| **Source / derivation** | Which state is canonical here, which is projected or cached, how stale can it be, and how is it rebuilt? |
| **Substrate contract** | Which guarantees does the code delegate to the database, queue, runtime, browser, provider, clock or operator? |

Map only the dimensions that can make or break the obligation. A pure formatter may need only representation. A retryable job with external effects may touch all nine. Record each boundary with the claim it constrains. A boundary is not automatically a transaction, a service or a bounded context.

### Run change probes

For each mapped claim, choose a nearby, credible domain change from the diff, the issue, the roadmap, or a repeated failure:

- add the next case, state, caller, consumer or relationship;
- change one policy, ownership rule, ordering rule or consistency boundary;
- add a second representation, context, account or execution attempt;
- change the source of truth or a substrate guarantee that the code depends on.

Then record:

| Obligation | Dimension | Domain claim | Current code mechanism / owner / representation | Grounded change | Coordinated edits | Enforcement |
| ---------- | --------- | ------------ | ----------------------------------------------- | --------------- | ----------------- | ----------- |

For each domain claim, find the code mechanism, owner or representation, or record that none exists. A mismatch in decomposition, ownership, placement, dependency direction, representation or substrate use is a candidate up-finding. Name its shape with the six axes, and use the admission gates to decide. If the maps agree but an execution breaks the claim, that is a down-finding. The up-pass stops when every affected obligation has a code map and every mismatch clears the gates or is discarded.

## Six axes for looking up

The axes organize the search. They do not list every improvement a reviewer can find. Each axis has a **tell** (a cheap trigger for the wide pass), a **pointer** (the question to run on a hit), and an **anti-pattern** (the over-application that makes drift worse).

1. **Repetition** — too many copies of one thing.
   Tell: the same literal, shape or try-catch appears three or more times. Pointer: _how many places change together when this one fact changes?_ Anti-pattern: a merge of copies that only look alike and change on their own.
2. **Conflation** — one construct does several jobs.
   Tell: the true description contains "and" or "or"; a boolean parameter switches the behavior; a vague name (`handle`, `process`, `data`). Pointer: _is this one concept or two?_ Anti-pattern: a split of one thing into many, with an indirection cost.
3. **Misplacement** — a seam that is not at the joint of the domain.
   Tell: a feature imports a non-public file of another feature; a `utils` folder grows; a helper lives far from its only caller. Pointer: _does this belong to the thing it lives in?_ Anti-pattern: a move to a tidier taxonomy that is farther from use.
4. **Wrong dependency direction** — a stable module depends on a volatile one.
   Tell: an import cycle; a shared module imports an app-specific one. Pointer: _which side is more stable?_ Anti-pattern: a one-implementer interface added "for flexibility".
5. **Loose representation** — the encoding allows illegal states.
   Tell: nullable fields with many `!`; several booleans that are never true together (a hidden enum); an `as` cast. Pointer: _can I tighten this until the wrong state does not compile?_ Anti-pattern: freezing an accident of today into a constraint.
6. **Reinvention** — the code rebuilds what the substrate gives.
   Tell: a hand-rolled thing with a primitive one import away (a manual JSON try/catch where zod exists). Pointer: _what does the library already give?_ Anti-pattern: a coupling to a substrate detail that changes more than your own code.

A strong move often improves several axes at once. That supports a proposal, but one clearly shown axis is enough.

A tell is not a finding. Whether copies share one truth, or whether a type is looser than the domain, needs judgment. Conflation and misplacement have weak mechanical tells, so give them time.

## Required knowledge

The multi-edit revealer cannot see drift that causes damage at read time. A second measure covers it:

> **Required knowledge** is the set of facts that a correct call site depends on and that nothing at that call site supplies.

Count it:

1. Write the call as a person who does not know this codebase writes it.
2. List every way that call is now wrong.
3. For each way, name where the correct knowledge lives today, with the [enforcement tiers](./gate-design.md#enforcement-tiers).
4. **Required knowledge is the residue at tiers 4 and 5.** That count is the size of the finding.

The tell is the reverse of the rest of this doc: **the naive call that compiles and passes review is the failure.** A long "reach for these" table in an agent file does not solve this problem. It is an inventory of the problem.

Four shapes of required knowledge:

1. **A name you must already know.** The correct helper exists, and only prior knowledge finds it. Fix: hang the capability on the value that the caller already holds.
2. **An escape-hatch parameter.** An open hook sits where a closed set of policies belongs. Tell: one implementer, and the same three lines each time. Fix: make the policy data that the caller selects.
3. **A leaky primitive.** A value travels as a bare `string`, and its handling rules travel as prose. Fix: give it a type whose behavior is the policy.
4. **A restated shape.** One context is retyped once per participant. Fix: declare it once and derive the rest.

Required knowledge is a different measure, not a seventh axis. Shape 1 is misplacement, 2 is conflation and loose representation, 3 is loose representation, and 4 is repetition.

### Call-site narrative

Read one normal call site of each new or changed interface in execution order. Do not open the implementation.

> A strong call site states the workflow in domain order. It names product facts and actions. Setup and policy mechanics stay with their owner.

Checks:

1. **Intent is visible.** Names state the domain action and the role of each input.
2. **Mechanics are absent.** The caller does not coordinate registration, credentials, storage, caches, adapters or registry order.
3. **Hazards stay enforced.** Hidden auth, approval, retry, ordering, redaction and access rules move to tiers 1 to 3, not only to comments.
4. **Every hop is real.** Each object or method boundary stands for ownership, authority, lifetime or a domain operation. Reject a fluent facade whose steps only forward parameters.
5. **The ledger is negative.** The new interface removes more names and lifecycle facts than it adds.
6. **The words survive a change probe.** Add the next caller, mode, executor or policy. The domain case changes one owner, and a missed case fails statically or at the owning boundary.

The research basis is in [Readable module interfaces](../research/readable-module-interfaces.md).

### The vocabulary ledger

> Ledger = names required at the call site after the change − names required before. It must end negative. A PR that leaves it positive names the PR that closes it.

- **An incremental cutover starts a debt clock.** The PR that opens the clock names the closing PR. It marks the old path (internal, deprecated, or "callers are being migrated").
- **Two doors are worse than one bad door.** The naive call site must now choose, and the reviewer must know which choice is current.

### The hazard rule

> When a shared seam absorbs a hazard (retry, redaction, auth, ordering, truncation), the types of the seam must represent the hazard, not its docstring.

- **An absorbed hazard needs an OFF value in its type.** When the default answer of a seam is "on", an optional field is the wrong shape. Make the choice required where the client is built (`retry: RetryPolicy | "none"`).
- **Do not absorb a hazard that the layer below owns better.** A cache with no expiry around a value with an expiry makes a lifetime rule for the caller.
- A shared seam that cannot express the policy of a member has not generalized that member. It has excluded it.

## Three dimensions for drilling down

Down starts from a claim, not a file. Write the invariant before you trace it:

> Given **preconditions**, after any allowed sequence of **events and failures**, **property** stays true; if it cannot, **recovery** restores it without **forbidden effects**.

"The update succeeds" is not an invariant. "A retried webhook makes at most one domain write and acknowledges only after that write is durable" is an invariant.

Trace the claim in three dimensions:

- **Through the system — follow the value and the effect.** Start at every entry point. Cross validation and authorization. Follow state transitions and writes. Inspect every consumer and visible side effect. Find where ownership changes and where an error can be translated, swallowed or separated from its state.
- **Through time — follow the sequence.** Inspect before, during, after, retry, duplicate delivery, cancellation, concurrent execution, stale queued work, and recovery or backfill. Most deep defects are legal lines in an illegal order.
- **Down to authority — follow the claim to the layer that decides it.** A wrapper name, comment, mock or type is not proof of database, queue, browser or provider behavior. Read the substrate contract, or run the smallest probe.

Derive counterexamples from the state machine of the invariant. Stale state matters only where state can age. Idempotency matters only where work can repeat.

### What earns depth

- a multi-step write, queue or job, external side effect, cache, retry, migration or repair path;
- a changed contract, guard, authorization boundary, source of truth or persisted representation;
- a structural proposal that moves ownership or claims to make a class of failure impossible;
- a bug fix whose first patch closes one symptom and leaves sibling sequences open.

For each selected claim, try to produce a breaking sequence before you try to confirm it. Match the evidence to the claim: types or constraints for static impossibility, focused tests for local transitions, integration tests for persistence and concurrency, and dependency source or live probes for external semantics. A green unit test is not evidence for behavior that its mock does not model.

Down ends with one of three conclusions:

- **Closed within scope**: the named paths and assumptions preserve the invariant, with evidence.
- **Broken**: a concrete counterexample exists.
- **Unproven**: name the missing evidence and the residual risk.

"Looks correct" is not a conclusion.

## Admission gates

A structural proposal earns its place only when it clears these gates:

- **A. Name the change that it de-risks.** "This should be a registry" is taste. "The 13th key touches four files and can forget a default; a registry makes it one file and the type forbids the omission" is an argument.
- **B. Clear the anti-pattern of the axis.** Show that the parts share a truth or an invariant, not only syntax. Name the domain changes under which they change together.
- **C. Name the enforcement mechanism and its remaining gap.** Use the strongest combination of tiers that applies.
- **D. Show the vocabulary ledger.** For a proposal based on required knowledge, state which names a call site stops needing, which it starts needing, and when the old path is deleted.

A down-finding has a parallel burden:

- **A. State the invariant, not the symptom.**
- **B. Give the counterexample as a sequence:** precondition, event order, failure point, resulting state, and consequence.
- **C. Prove the substrate assumptions.** Separate what the code establishes from what a transaction, queue, provider or browser only seems to do.
- **D. Test the whole proposed closure.** A fix that moves the failure has not closed the invariant.

## The forcing function

A review that returns only local nits ran only the surface sweep. Before you finish:

- Give **at least one up-observation**, or state that you ran the pointers of the touched axes and none applies, with the reason.
- For each call site that the diff adds or changes, run the [required-knowledge](#required-knowledge) test and the [call-site narrative](#call-site-narrative) once. A residue at tier 4 or 5 is a finding.
- For each claim that earned depth, give a **down-conclusion** with the invariant and the evidence. If no claim earned depth, state why the change has low risk.

Silence is not evidence of a clean structure. It usually shows that the direction never ran.

## Summary pass

1. **Orient:** state the intent and the obligations. Classify the changed files as authored sources, generated artifacts or external internals.
2. **Map the domain:** recover the dimensions that can make or break each obligation.
3. **Probe and look up:** run grounded domain changes, compare each claim with its code mechanism, and classify mismatches with the six axes. Measure changed call sites for required knowledge and call-site narrative. Send execution counterexamples down.
4. **Sweep the surface:** apply [review-checklist.md](./review-checklist.md) to authored sources. Compare generated artifacts with their sources.
5. **Gate up-candidates:** name the exposed change, the shared truth, the anti-pattern risk, the mechanism, the remaining gap and the ledger. Ask: would one domain change land in one place, because no other place exists?
6. **Choose depth:** select risky invariants and restructures that move ownership or behavior.
7. **Drill down:** follow each claim through the system, through time and to the deciding substrate. Look for a breaking sequence.
8. **Loop:** if several down-findings share a cause, look up for the missing mechanism. Prove any up-proposal down again.
9. **Report:** give the up-observation and the conclusion of each selected claim.

The incident behind the invariant-closure rule is in `.lessons/refresh-pr-head-before-final-review.md`. The reasons behind the architecture are in [decisions.md](../../decisions.md).

The vocabulary comes from the [DDD reference](https://www.domainlanguage.com/ddd/reference/) (identity, authority, aggregates, bounded contexts), [Parnas's decomposition criterion](https://dl.acm.org/doi/10.1145/361598.361623) (change-oriented boundaries), [Parse, Don't Validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) (representation at trust boundaries), [safety and liveness](https://www.cs.cornell.edu/fbs/publications/DefLiveness.pdf), [Lamport's causal ordering](https://lamport.azurewebsites.net/pubs/time-clocks.pdf) and [transaction limits](https://www.vldb.org/conf/1981/P144.PDF) (down-proof), and [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods) (retry semantics). These sources give questions, not architectures to impose.
