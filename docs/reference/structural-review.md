# Structural review — looking above and below the diff

[code-style.md](./code-style.md) is the **surface sweep**: a bounded catalog of recurring review rules to apply to present code. This doc covers the two open-ended directions that sweep cannot reach. Look **up** from the changed lines to ask whether the code has the right shape; drill **down** through them to ask whether the claimed behavior survives relevant paths, states, and failures. Read this when the diff may be correct line-by-line but either its *shape* or its *invariant* might still be wrong.

---

## Three review motions

Treat the changed lines as a surface. The framework distinguishes three review motions:

- **Surface is rule-guided verification.** Sweep all changed code against the known rules in [code-style.md](./code-style.md). The prompts are known in advance, so the work is bounded and repeatable even though applying some rules still requires judgment; parts can be automated.
- **Up is structural search.** Infer a better domain shape that is not present yet, then measure the code against it. The target itself is unknown, so the work is generative and subjective. This is where "these twelve `localStorage` calls should be one registry" and "`isRecord` is really two guards" live.
- **Down is invariant proof.** Start with a behavior the change claims, then trace it through callers, state transitions, persistence, consumers, time, and failure until either the relevant paths preserve it or a counterexample breaks it. The target is known but the proof path is not. This is where "the FK guard prevents a dangling reference but leaves the artifact stuck in `generating`" and "the happy path is correct but a retry duplicates the side effect" live.

These motions need different tools. Tool verification with a list. Tool up with a heuristic — *what shape might be missing and how would we score it?* Tool down with a falsification strategy — *what exact invariant is claimed and what sequence would break it?* A list cannot generate the missing abstraction, and line inspection cannot prove an end-to-end behavior.

**Fund up first; earn down selectively.** Run structural discovery before the known-rule sweep so familiar local prompts do not anchor the whole review. Then spend expensive down-depth on risky claims and candidate structures. Down is selective because proving everything exhaustively is impossible, not because untraced code is assumed correct.

The two open directions strengthen each other:

- **Up without down produces elegant incompleteness.** A registry can centralize the new shape while mishandling legacy persisted data; a split guard can be conceptually right while changing a caller that relied on the old ambiguity.
- **Down without up produces serial patches.** A reviewer can close retries, stale state, and partial failure one at a time while missing that the same absent boundary or loose representation keeps recreating the class.
- **The loop is the method.** Discover upward, prove downward. When the proof finds several sibling failures, look upward again for the missing structure that would make the invariant inevitable, then trace the proposed structure downward once more.

---

## What a structural defect is

The essence is **drift between the code's structure and the domain's structure** — the code splits what's really one thing, fuses what's really two, or claims a shape it doesn't enforce.

That essence is hard to measure directly, so use its sharpest **revealer** (a reliable tell, not the definition):

> A structural defect reveals itself when one domain change requires multiple coordinated edits and nothing makes that coordination inevitable.

Two things about this sentence do the work. "Multiple coordinated edits" is the most *objective* symptom of drift — it converts taste into a cost you can name. "Nothing makes that coordination inevitable" is a gradient, not a binary; see [the enforcement ladder](#the-enforcement-ladder) for how strongly "inevitable" is actually being enforced.

The multi-edit test is the sharpest revealer, not the only one. Drift can bite **before** it ever forces a second edit:

1. **Multiple coordinated edits** — the change touches N places and consistency isn't enforced. *(most objective)*
2. **Unsafe extension** — adding the next case is possible but unguided; the code lets you get it wrong (you *can* forget the default).
3. **Comprehension obstruction** — a reader can't recover the domain's shape from the code's shape; the map lies. *(most subjective, earliest to bite)*

The storage registry improves all three — one edit to add a key, the type forbids a missing default, and one file shows the whole catalog. The multi-edit argument is just the most *legible* of its three benefits. Lead with whichever revealer is most objective for the case at hand.

---

## Breadth discovers; depth proves

Discovery is breadth-first; depth is earned. The microscope **confirms** a structural smell and **tries to break** a behavioral claim — it does not discover missing structure by itself.

- **Pass 1 — orient.** Recover the change's intent, claimed invariants, affected domain facts, and trust boundaries. Without this, up has no domain to model and down has no claim to prove.
- **Pass 2 — wide, shallow, cheap (up-discovery).** Map where each fact, operation, and shape lives and how many homes it has. Collect candidate smells whose fix may not exist yet. Do not deep-read every function or dependency internal.
- **Pass 3 — bounded surface sweep.** Run the known review rules across authored changed code, and reconcile generated artifacts against their sources. The prompts are comprehensive within the checklist's vocabulary; their application can still require judgment.
- **Pass 4 — deep, only where earned (down-proof).** Trace risky claimed invariants and candidate restructures through callers, state, dependencies, and failure modes. Try to falsify them with concrete sequences and use evidence at the boundary where the claim actually lives.

Reading every function and every `node_modules` file with a microscope spends the whole budget on indiscriminate depth and none on wide perception. But stopping after the wide pass is equally incomplete: it finds promising shapes without proving that they preserve behavior. Breadth chooses where depth will pay.

### Review sources, reconcile artifacts

Not every changed file deserves the same kind of attention. Classify the diff before reviewing it:

- **Authored semantic sources** — application code, schemas, configuration, contracts, and hand-written migrations or scripts. These receive the normal surface sweep, contribute to the up-map, and may earn down-depth.
- **Generated or derived artifacts** — lockfiles, generated SQL, snapshots, generated clients, build output, and formatted metadata. Do not style-review or structurally redesign machine output. Reconcile the artifact against the authored source and the intended semantic delta: did the package request resolve to the expected version, did schema generation emit only the intended operations, did a snapshot change for the stated reason?
- **External internals** — dependency source, generated framework internals, database implementation details, or provider behavior. They are not part of the routine review surface. Descend into them only when the invariant depends on behavior that public contracts, types, and focused probes do not establish.

This is selective attention, not an ignore list. A generated file becomes evidence when its delta is surprising or high-consequence. A lockfile warrants deeper inspection for an unexpected source, duplicate/incompatible resolution, or version mismatch. Generated migration SQL warrants deeper inspection for destructive or reordered operations, unsafe casts, or a mismatch with the declared schema. The trigger is a concrete semantic question; absent one, verify provenance and expected shape, then move on.

---

## Map the domain before judging the structure

The six axes below classify **how** code structure disagrees with domain structure; they do not tell a reviewer **what domain structure to recover**. Start the up-pass with an obligation: what must always remain true (safety), eventually become true (liveness), or never occur? Then map the domain dimensions that can make or break it.

| Dimension | What to recover from the domain |
| --- | --- |
| **Identity** | What persists through change? What counts as the same entity, attempt, message, value, or relationship? |
| **Authority** | Who may decide, mutate, validate, and enforce each rule, and over what scope? |
| **Lifecycle / state** | What states, events, guards, terminal outcomes, and recovery transitions are legal? |
| **Consistency / coordination** | Which observations or changes must agree? What atomicity, isolation, ordering, locking, or compensation holds them together? |
| **Time / order** | Which claims depend on causality, freshness, deadlines, leases, expiry, scheduling, or wall-clock time? |
| **Effects / resources** | What is read, written, emitted, consumed, reserved, billed, retried, cancelled, acquired, or released? Which effects are irreversible? |
| **Representation** | Which domain, wire, storage, and UI encodings exist? Which distinctions and invalid states do they preserve or erase, and where are values parsed or normalized? |
| **Source / derivation** | Which state is canonical in this context, which is projected or cached, how stale may it be, and how is it rebuilt or reconciled? |
| **Substrate contract** | Which guarantees and failure assumptions are delegated to the database, queue, runtime, browser, provider, clock, or operator? |

These are review vocabulary, not nine architecture components. Do not fill every row ritualistically. Begin with the obligation and map only the dimensions that can make or break it: a pure formatter may need representation alone; a retryable job with external effects may touch almost all nine. Record each boundary with the claim it constrains instead of treating "boundary" as one thing: semantic scope belongs with authority and source, a consistency boundary with coordination, a trust boundary with representation, and a deployment boundary with the substrate contract. None is automatically a transaction, service, or bounded context.

Evidence is not a tenth domain dimension; it is how the reviewer proves claims across all nine. Observability can supply evidence about identity, state, causality, and effects, but telemetry does not itself establish correctness. Recovery likewise belongs in the lifecycle, effects, source/derivation, and substrate claims it restores.

The primitives deliberately describe the problem rather than prescribe the answer. Historical fixes in this tree include registries, discriminated result envelopes, transaction-owned operations, monotonic cursors, boundary adapters, and capability objects. Those are candidate structures generated from a map; none is a primitive that every domain should contain.

### Run change probes

For each mapped claim, choose a nearby, credible domain change grounded in the diff, issue, roadmap, or a repeated historical failure:

- add the next case, state, caller, consumer, or relationship;
- change one policy, ownership rule, ordering rule, or consistency boundary;
- introduce a second representation, context, account, or execution attempt;
- change the source of truth or a substrate guarantee the code currently leans on.

Then record:

| Obligation | Dimension | Domain claim | Current code mechanism / owner / representation | Grounded change | Coordinated edits | Enforcement |
| --- | --- | --- | --- | --- | --- | --- |

For every relevant domain claim, locate the corresponding code mechanism, owner, or representation — or record that none exists. A mismatch in decomposition, ownership, placement, dependency direction, representation, or substrate use is a candidate up-finding; use the six axes to name its shape and the admission gates to decide whether changing it beats leaving it alone. If the maps align but an execution fails to preserve the claim, that is a down-finding instead. This is the up-pass's work product and stopping rule: every affected obligation has an explicit code map; every structural mismatch either clears the gates or is discarded.

The same map becomes the specification for drilling down. Up asks whether the owners, boundaries, and representations match the domain; down asks whether those claims survive actual execution.

---

## Six axes for looking up

These axes cover the recurring ways code structure drifts from domain structure. They organize the search; they do not enumerate the improvements a reviewer may discover. Treat them as lenses, not as a proof that every possible structural defect fits a closed taxonomy.

Each axis carries a **tell** (a cheap trigger you can spot in the wide pass), a **pointer** (the generative question you run on the hit), and an **anti-pattern** (the over-application that makes drift *worse*).

**1. Repetition** — *elements: too many copies of one.*
- Tell (greppable): the same literal / shape / try-catch appears 3+ times.
- Pointer: *how many places change together if this one fact changes?*
- Anti-pattern: DRYing *coincidental* duplication — things that look alike but change independently.
- Example: the localStorage **registry**; `parseEmailAddress` as the single source of self-mail matching.

**2. Conflation** — *elements: one construct doing several jobs.*
- Tell: the true description contains "and"/"or"; a boolean parameter that switches behavior; a vague name (`handle`, `process`, `data`) broad enough to hide two concepts.
- Pointer: *is this one concept or two? does the name make a single promise?*
- Anti-pattern: over-decomposition — splitting things that really are one, paying an indirection tax.
- Example: the **`isRecord` / `isIndexable` split** — one name was answering "is this plain JSON?" and "can I read a field off this?", which a `Date` answers oppositely.

**3. Misplacement** — *boundaries: seams not cut at the domain's joints.*
- Tell: a feature imports another feature's non-public file; a `utils` folder accreting unrelated things; a helper living far from its only caller.
- Pointer: *is this cut where the domain actually joints? does this belong to the thing it lives in?*
- Anti-pattern: moving code to a tidier taxonomy that's farther from use — colocation usually beats classification.

**4. Wrong dependency direction** — *dependencies: stable follows volatile.*
- Tell (partly automatable): an import cycle; a stable/shared module importing an app-specific one (`contracts` reaching into `api`; the `storage-schemas → domain → storage` cycle its header guards against).
- Pointer: *does the more-stable thing depend on the more-volatile, or the reverse?*
- Anti-pattern: a one-implementer interface added "for flexibility" — speculative generality.

**5. Loose representation** — *encodings: illegal states allowed.*
- Tell (greppable): nullable fields littered with `!`; several booleans never independently true (a disguised enum); an `as` cast — the cast is the code *confessing* its type is looser than reality.
- Pointer: *does this encoding permit a state the domain forbids? can I tighten it until wrong won't compile?*
- Anti-pattern: freezing today's accident into tomorrow's constraint by over-tightening.
- Example: `satisfies Record<string, z.ZodDefault>` makes "a registered key with no default" unrepresentable.

**6. Reinvention** — *substrate: rebuilding what's provided.*
- Tell (greppable): a hand-rolled thing with a substrate primitive one import away — manual JSON try/catch where Zod exists; a hand-written insert type where `$inferInsert` exists.
- Pointer: *what does the library already give me that this rebuilds?*
- Anti-pattern: coupling to a substrate detail that's actually more volatile than your own code.

High-value moves often improve several axes at once — the registry is **1 + 5 + 6**, the guard split is **2 + 5**. That convergence strengthens a proposal, but it is supporting evidence rather than a scoring system: one clearly demonstrated axis is enough.

### Where judgment actually goes

Some **tells** are cheap enough to collect during the bounded surface sweep:

- **Repetition and loose representation** — candidate sites are often greppable (`as`, `!`, duplicated literals or shapes).
- **Wrong direction** — cycle detection and boundary lint (`pnpm check:web-boundaries` is already a slice of this).

But a tell is not a finding. Deciding whether duplication shares one truth, whether a type is looser than the domain, or whether library behavior really subsumes local code still requires judgment. **Conflation** (*is this one concept or two?*) and **misplacement** (*is this cut at the joint?*) have especially weak mechanical tells, so protect time for them — but do not pretend the other axes can be concluded by grep. The registry began with a repetition tell and required the global claim that all keys form one catalog; the guard split required perceiving two concepts behind one name.

---

## Three dimensions for drilling down

Down starts from a claim, not a file. Write the intended invariant before tracing it:

> Given **preconditions**, after any allowed sequence of **events and failures**, **property** remains true; if it cannot, **recovery** restores it without **forbidden effects**.

"The update succeeds" is not an invariant. "A retried webhook creates at most one domain write and acknowledges only after that write is durable" is. The sharper sentence tells the reviewer which counterexamples matter and when the proof is complete.

Trace the claim in three dimensions:

- **Through the system — follow the value and effect.** Start at every entry point, cross validation and authorization, follow state transitions and writes, then inspect every consumer and externally visible side effect. Ask where ownership changes and where an error can be translated, swallowed, or separated from the state it describes.
- **Through time — follow the sequence.** Inspect before, during, after, retry, duplicate delivery, cancellation, concurrent execution, stale queued work, and recovery/backfill. Most deep defects are legal lines in an illegal order.
- **Down to authority — follow the claim to the layer that decides it.** A wrapper name, comment, mock, or type is not proof of database, queue, browser, or provider behavior. Read the substrate contract or run the smallest integration/live probe when the invariant depends on its semantics.

These are search dimensions, not a demand to enumerate the universe. Derive concrete counterexamples from the invariant's own state machine. Stale state matters only where state can age; idempotency matters only where work can repeat; partial failure matters where one logical action crosses atomicity boundaries. Generic failure lists are prompts for finding those joints, not proof that the invariant was audited.

### What earns depth

Deep tracing is expensive, so spend it where the consequence or uncertainty is high:

- a multi-step write, queue/job, external side effect, cache, retry, migration, or repair path;
- a changed contract, guard, authorization boundary, source of truth, or persisted representation;
- a structural proposal that moves ownership or claims to make a class of failure impossible;
- a bug fix whose first patch closes one symptom but leaves sibling sequences plausible.

For each selected claim, try to produce a concrete breaking sequence before trying to confirm it. Then use evidence matched to the claim: types or constraints for static impossibility, focused tests for local transitions, integration tests for persistence and concurrency, and dependency source or live probes for external semantics. A green unit test is not evidence for behavior its mock chose not to model.

Down ends with one of three conclusions: **closed within scope** (the explicitly named paths and assumptions preserve the invariant, with evidence), **broken** (a concrete counterexample exists), or **unproven** (name the missing evidence and residual risk). "Looks correct" is not a conclusion.

---

## The enforcement ladder

"Nothing makes that coordination inevitable" is a gradient. When a restructure claims to hold N edits together, name **how**, because the mechanism decides whether the gap is actually closed:

| Tier | Mechanism | Effect |
| --- | --- | --- |
| 1 | **Static enforcement** | Construction, types, lint, or boundary checks reject the wrong structure before runtime. |
| 2 | **Runtime validation** | The wrong value can't enter or persist. |
| 3 | **Centralized ownership** | One place owns the fact or operation — a source of truth. |
| 4 | Tests | Divergence is *detected*, after it happens. |
| 5 | Convention / documentation | Humans are *asked* not to diverge. |

**Only tiers 1–3 substantially close the structural gap.** Tests detect drift after the fact; convention merely requests that humans not introduce it. But the tiers are not interchangeable: static types cannot validate untrusted runtime data, and centralized ownership does not prevent bypass unless a boundary check also closes the other doors. Choose the earliest mechanism that can enforce the specific invariant, and compose mechanisms when the invariant crosses static, runtime, and ownership boundaries.

Grounded in this tree:

- **Tier 1** — `satisfies Record<string, z.ZodDefault>` (a key without a default won't build); `LocalStorageValue<K>` derived from the schema so the type can't drift; the `const _exhaustive: never` switch guard; `check:web-boundaries` rejecting a forbidden import.
- **Tier 2** — `setLocalStorageItem` `safeParse`-refuses an invalid value; boundary Zod parses on untrusted input.
- **Tier 3** — the registry as the one catalog; `safeGet`/`safeSet`/`safeRemove` as the intended door to `window.localStorage`; `parseEmailAddress` as the single matcher.
- **Tier 4** — `guards.test.ts` catches an `isRecord` regression, but doesn't *prevent* someone re-widening it.
- **Tier 5** — "don't call `window.localStorage` outside `storage.ts`" is enforced by nothing but this sentence; it stays tier 5 until a check covers it. Contrast the sibling browser/server *import* rule, which was promoted out of tier 5 by `check:web-boundaries` (→ tier 1) — the upgrade move this whole ladder is asking for.

A cast (`as`) asks the compiler to trust a claim it did not prove. That makes it a useful axis-5 tell, though not automatically a defect: the review still has to find the owning boundary and determine whether validation or a derived type can replace the claim.

---

## Admission gates

Subjective doesn't mean unrigorous. A structural proposal earns its place only if it clears three gates:

- **A. Name the change it de-risks.** "This should be a registry" is taste. "Adding the 13th key touches 4 files and can silently forget a default; a registry makes it one file and the type forbids forgetting" is an argument. No named change → rejected as aesthetics.
- **B. Clear the axis's anti-pattern.** State that the things genuinely share a *truth or invariant*, not merely syntax — name the domain changes under which they co-vary, or show that the seam is the domain's real joint. This is the guardrail that stops "find the hidden registry" from becoming its own checklist that manufactures speculative architecture.
- **C. Name the enforcement mechanism and its remaining gap.** A registry held together by "please import from here" (tier 5) is weaker than one whose entries are statically checked (tier 1), but runtime input may still need validation (tier 2). Use the strongest applicable combination rather than assuming one tier replaces the others.

A down-finding has a parallel burden:

- **A. State the invariant, not the symptom.** "This row can stay `generating`" matters because it violates a named lifecycle or recovery guarantee.
- **B. Give the counterexample as a sequence.** Name the precondition, event order, failure point, resulting state, and user-visible or operational consequence.
- **C. Prove the substrate assumptions.** Distinguish what the code establishes from what a transaction, queue, provider, or browser is merely assumed to do.
- **D. Test the whole proposed closure.** A fix that prevents a dangling foreign key by silently stranding the parent state has moved the failure, not closed the invariant.

---

## The forcing function

A review that returns only local nits has performed only the surface sweep. Before finishing:

- Produce **at least one up-observation** by running the pointers for the axes the diff touches, or state explicitly that you looked and none applies, and why.
- For every claim that earned depth, give a **down-conclusion**: closed within scope, broken, or unproven, with the invariant and evidence. If no claim earned depth, state why the change is low-risk enough not to trace.

Silence is not evidence of clean structure or closed behavior; it is usually evidence that the corresponding direction never ran.

---

## Summary pass

1. **Orient:** state the change's intent and obligations; classify changed files as authored sources, derived artifacts, or external internals.
2. **Map the domain:** recover the relevant identities, authorities, lifecycle, coordination, time, effects, representations, sources, and substrate assumptions; qualify each boundary at the dimension it constrains.
3. **Probe and look up:** run grounded domain changes, compare each claim with its code mechanism, owner, or representation, then classify structural mismatches with the six axes; route execution counterexamples down.
4. **Sweep the surface:** apply the bounded [code-style.md](./code-style.md) prompts to authored semantic sources; reconcile generated artifacts against their source and intended delta.
5. **Gate up-candidates:** name the exposing change, shared truth, anti-pattern risk, enforcement mechanism, and remaining gap.
6. **Choose depth:** select risky invariants and restructures that move ownership or behavior.
7. **Drill down:** follow each claim through the system, through time, and to the authoritative substrate; actively seek a breaking sequence.
8. **Loop:** if several down-findings share a cause, look up for the missing mechanism; if an up-proposal emerges, prove it down again.
9. **Report:** give the required up-observation and each selected claim's closed-within-scope / broken / unproven conclusion.

> The bounded surface checklist is [code-style.md](./code-style.md). The incident that motivated invariant closure is captured in `.lessons/refresh-pr-head-before-final-review.md`. The *why* behind the architecture these methods protect is [decisions.md](../../decisions.md).

The vocabulary is grounded in the [DDD reference](https://www.domainlanguage.com/ddd/reference/) for identity, authority, aggregates, and bounded contexts; [Parnas's decomposition criterion](https://dl.acm.org/doi/10.1145/361598.361623) for change-oriented boundaries; [Parse, Don't Validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) for representation at trust boundaries; [safety and liveness](https://www.cs.cornell.edu/fbs/publications/DefLiveness.pdf), [Lamport's causal ordering](https://lamport.azurewebsites.net/pubs/time-clocks.pdf), and [transaction limits](https://www.vldb.org/conf/1981/P144.PDF) for down-proof; and [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods) for precise retry semantics. These are sources for questions, not architectures to impose.
