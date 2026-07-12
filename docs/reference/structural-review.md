# Structural review — finding what the checklist can't

[code-style.md](./code-style.md) is the **floor**: a closed list of known defects you match present code against. This doc is the **ceiling**: searching for structural improvements whose final shape is not present and cannot be enumerated in advance. The two are different activities and need different tooling — read this when the diff is correct line-by-line but the *shape* might be wrong.

---

## The two altitudes

A review runs at two altitudes, and they behave differently at the root:

- **Down is verification.** Match present code against a fixed vocabulary of known-bad patterns (the [code-style.md](./code-style.md) hit-list). The question and acceptance criterion are known in advance, so the work is bounded and repeatable; parts of it can be automated.
- **Up is search.** The fix doesn't exist in the code yet — you have to *generate* the better shape and measure the gap. Open-ended, subjective, and impossible to cache into a list, because there's no present pattern to match against. This is where "these twelve `localStorage` calls should be one registry" and "`isRecord` is really two guards" live.

You tool retrieval with a list. You tool search with a heuristic — *what to look for* and *how to score a candidate*. Handing an open search a closed list is why structural wins get missed.

**Fund up first.** Down pays a constant, certain reward (there's always another cast to flag), up pays an uncertain reward after a speculative claim. Under any attention budget, attention drifts toward the certain drip. So don't make them compete: run down as a cheap deterministic sweep, and protect a separate, earlier budget for up.

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

## Depth follows the smell

Discovery is breadth-first; depth is earned. The microscope **confirms** a smell — it doesn't **discover** one.

- **Pass 1 — wide, shallow, cheap (discovery).** Map where each fact/operation/shape lives and how many homes it has. Collect candidate smells, including structural ones you'd have to invent the fix for. Don't deep-read functions or dependency internals yet.
- **Pass 2 — deep, only on the hits (confirmation).** Now microscope — but only what a smell flagged, verifying both the local correctness of the changed lines and the viability of the structural proposal.

Reading every function and every `node_modules` file with a microscope spends the whole budget on down-direction verification and none on up-direction perception. It is backwards for finding the high-value change.

---

## Six axes of structural drift

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

The highest-value moves usually satisfy several axes at once — the registry is **1 + 5 + 6**, the guard split is **2 + 5** — which is itself a signal the restructure is real and not aesthetic.

### Where judgment actually goes

Some **tells** are cheap enough to collect during the deterministic sweep:

- **Repetition and loose representation** — candidate sites are often greppable (`as`, `!`, duplicated literals or shapes).
- **Wrong direction** — cycle detection and boundary lint (`pnpm check:web-boundaries` is already a slice of this).

But a tell is not a finding. Deciding whether duplication shares one truth, whether a type is looser than the domain, or whether library behavior really subsumes local code still requires judgment. **Conflation** (*is this one concept or two?*) and **misplacement** (*is this cut at the joint?*) have especially weak mechanical tells, so protect time for them—but do not pretend the other axes can be concluded by grep. The registry began with a repetition tell and required the global claim that all keys form one catalog; the guard split required perceiving two concepts behind one name.

---

## The enforcement ladder

"Nothing makes that coordination inevitable" is a gradient. When a restructure claims to hold N edits together, name **how**, because the mechanism decides whether the gap is actually closed:

| Tier | Mechanism | Effect |
| --- | --- | --- |
| 1 | **Static enforcement** | Construction, types, lint, or boundary checks reject the wrong structure before runtime. |
| 2 | **Runtime validation** | The wrong value can't enter or persist. |
| 3 | **Centralized ownership** | One place owns it — a single door / source of truth. |
| 4 | Tests | Divergence is *detected*, after it happens. |
| 5 | Convention / documentation | Humans are *asked* not to diverge. |

**Only tiers 1–3 substantially close the structural gap.** Tests detect drift after the fact; convention merely requests that humans not introduce it. Two proposals can target the same drift and close it to very different degrees — so a reviewer's job is to **push a proposal up the ladder**: can this convention become a lint rule? can this test become a type? can this runtime check become a compile-time impossibility?

Grounded in this tree:

- **Tier 1** — `satisfies Record<string, z.ZodDefault>` (a key without a default won't build); `LocalStorageValue<K>` derived from the schema so the type can't drift; the `const _exhaustive: never` switch guard; `check:web-boundaries` rejecting a forbidden import.
- **Tier 2** — `setLocalStorageItem` `safeParse`-refuses an invalid value; boundary Zod parses on untrusted input.
- **Tier 3** — the registry as the one catalog; `safeGet`/`safeSet`/`safeRemove` as the only door to `window.localStorage`; `parseEmailAddress` as the single matcher.
- **Tier 4** — `guards.test.ts` catches an `isRecord` regression, but doesn't *prevent* someone re-widening it.
- **Tier 5** — "don't call `window.localStorage` outside `storage.ts`" is a convention until a check enforces it. The move that made the browser/server boundary real was upgrading that convention to `check:web-boundaries` (tier 5 → tier 1).

A cast (`as`) asks the compiler to trust a claim it did not prove. That makes it a useful axis-5 tell, though not automatically a defect: the review still has to find the owning boundary and determine whether validation or a derived type can replace the claim.

---

## What makes an up-proposal admissible

Subjective doesn't mean unrigorous. A structural proposal earns its place only if it clears three gates:

- **A. Name the change it de-risks.** "This should be a registry" is taste. "Adding the 13th key touches 4 files and can silently forget a default; a registry makes it one file and the type forbids forgetting" is an argument. No named change → rejected as aesthetics.
- **B. Clear the axis's anti-pattern.** State that the things genuinely share a *truth or invariant*, not merely syntax — that they co-vary under every plausible change, or that the seam is the domain's real joint. This is the guardrail that stops "find the hidden registry" from becoming its own checklist that manufactures speculative architecture.
- **C. Name the enforcement tier, and take the strongest available.** A registry held together by "please import from here" (tier 5) is a much weaker fix than one where the wrong thing won't compile (tier 1). Prefer the highest tier the substrate allows.

---

## The forcing function

A review that returns only local nits has skipped the ceiling. Before finishing, produce **at least one structural observation** — run the pointer for whichever axes the diff touches — **or state explicitly that you looked and none applies, and why.** Silence is not evidence of a clean structure; it's usually evidence the up-pass never ran.

---

## The up-direction pass (summary hit-list)

1. For each fact the diff touches, **count its homes.** More than one, held by convention → candidate registry / source-of-truth (usually axis 1; axis 4 if ownership is inverted).
2. For each name the diff adds or changes, ask **one concept or two.** An "and"/"or" description or a mode-switch boolean → candidate split (axis 2).
3. Spot the **greppable tells** — `as`, `!`, duplicated shapes, hand-rolled-where-a-primitive-exists — and tighten toward tier 1 (axes 5, 6).
4. For each structural proposal, clear the **three gates**: name the change, prove shared truth (not syntax), take the strongest enforcement tier.
5. Emit the **required structural observation**, or an explicit reasoned "none applies."

> This is the *up / ceiling* method. The *down / floor* checklist is [code-style.md](./code-style.md); the *depth-on-a-risky-change* discipline (prove the invariant end-to-end) lives in `.lessons/refresh-pr-head-before-final-review.md`. The *why* behind the architecture these protect is [decisions.md](../../decisions.md).
