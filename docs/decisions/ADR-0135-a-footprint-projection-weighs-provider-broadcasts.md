# ADR-0135 — A footprint projection weighs provider broadcasts (ACCEPTED — 2026-11-26; not built)

**Status.** Accepted, not built. Owner decision, 2026-11-26, after four briefings led by advisories for providers the owner does not use. Extends the context-graph theory (`docs/theory/context-graph.md` — the verdict is a projection in that glossary's sense) and [ADR-0083](./ADR-0083-briefing-context-signals-are-a-typed-middle.md) (the verdict reaches the composer as a typed signal derived from the projection). Relates to [ADR-0080](./ADR-0080-identity-facts-are-a-deterministic-projection.md) and the resolution theory (`docs/theory/resolution.md`), whose seam this ADR closes for the parts it touches (D5).

**Problem.** The briefing's ranking rule gives "an official hazard warning" the lead unconditionally, so legitimacy and relevance collapse into one question. A mass security notice from Render — a provider the owner has no projects on, no connection to, and no history with — led both slots of the Nov 25 and Nov 26 briefings, ahead of things that needed the owner. The same week, Prisma Accelerate retirement and Google Cloud Workspace policy mail took priority slots. Nothing in the pipeline asks whether the warned-about thing exists in the owner's world. The owner's correction: **legitimacy is not relevance** — a real message from a real provider still may not be about the user's life, and a one-owner product cannot hardcode the answer.

**Decision.** A **footprint projection** answers, per provider (or per thing a broadcast names), one question with claim-shaped evidence: *is this in the user's world?* The verdict is a query-time fold over the context-graph stores — never a durable row, because the interesting verdict, "not in the footprint," is an absence-of-evidence inference that new evidence would falsify and a durable row would rot. The briefing consumes the verdict as a new ADR-0083 signal kind; chat consumes the same projection. Demotion applies only to provider-initiated broadcasts and only on a confident negative; loop asks (mails naming an owned object — a repo, a deploy target, a thread with a person waiting) keep today's weight unconditionally.

**Evidence.** Measured 2026-11-26: the Render notice (CVE-2026-125396) led four consecutive briefings while Render is absent from every footprint store — not connected, no object-state rows, and no Render-domain mail in the triaged corpus. The composer's own hedge ("if any Render service hasn't deployed…") shows the model *knew* the match was unverified and had no store to ask. The inversion is the product gain: the same fold that demotes the Render notice would promote a Render incident the day the owner connects Render.

## D1 — The verdict is query-time, three-state, and evidence-cited

- Shape: `{ in-footprint | not-in-footprint | unknown }` + evidence. Positive footprint is durable truth owned by existing domains (a connection row, an object-state row, a claim); negative footprint is always an inference over what those stores hold today.
- "Unknown" is the honest state when sight is thin. Only a confident `not-in-footprint` changes ranking; `unknown` keeps today's weight with softened wording.
- The projection never persists. It is a read model, like ADR-0080's identity projection is a read over `observations` — and it inherits the same law: recomputed as evidence arrives, never learned from itself (theory principle 5).

## D2 — The class is structural: a broadcast names no owned object

- Provider-initiated broadcasts (security, policy, retirement, billing notices) are identified structurally — the mail names nothing that exists in the footprint stores — never by sender list or subject match. A sender list is brittle and would wrongly demote a Railway incident notice the day Railway matters.
- Loop asks keep today's weight. The failed-deploy mail that this ADR's sibling fault (ADR-0134) kept alive belongs to the loop class: it names a run on the owner's repo.

## D3 — Identity-keyed, never word-keyed

- The fold matches identities, not prose. A provider's canonical identity form is its domain set — from `INTEGRATIONS[slug]` when Alfred has an entry, and from the broadcast mail's own sender and link domains when it does not. A connection endpoint, an object-state key or URL, or a triaged thread touching those domains is evidence; the word "render" in prose never is.
- This is the resolution theory applied ("a name is not an identity; Alfred resolves a name to a thing before it acts"): a personal project named "render" on Railway is caught correctly because object-state keys are typed, not word-matched.

## D4 — What a demoted broadcast looks like

- A confident `not-in-footprint` broadcast never leads, cannot justify a send by itself, and collapses with its siblings into one trailing sentence with a mandatory hedge in the absence-of-evidence words: "nothing in your world suggests you use Render, so this likely doesn't apply."
- The degrade is to one line, never to silence (the owner's rule: err toward surfacing). The morning gate treats such lines as wallpaper, not substance. An `in-footprint` broadcast keeps today's weight: leads, full sentences.

## D5 — Evidence sources, build order, and the seam this ADR closes

- Slice 1 folds three stores, all live in prod today: **connections** (provider connected?), **`integration_objects`** (any thing, key, or URL naming the provider?), and the **triaged-mail corpus** (any thread touching the provider's domains in the lookback window — the strongest negative evidence: months of mail and zero mentions is looked-and-found-nothing, not blindness). The demotion bar is positive sight: the corpus was readable and returned nothing, never "we couldn't look."
- The **user's own words** are the fourth evidence source and a reserved seat: "I don't have any projects in Render" spoken in chat is claim-shaped evidence under the memory theory ("Claim" replaces "fact", `docs/theory/memory.md`). It joins the fold when the claims store and name resolution (ADR-0123's lane) let a spoken name resolve to the provider thing — not before, because a word-keyed fold today would re-introduce the D3 trap.
- Seam closure, for the parts touched: ADR-0083's briefing signals and ADR-0080's identity projection sit in the context-graph vocabulary as follows — signals are query-time projections over graph stores (this ADR's verdict is one), and identity facts are a projection over `observations` that can cite things and identities as evidence. The full reconciliation (every signal kind, all of ADR-0080) is its own future ADR.
- Worst error, named for the eval gate (theory principle 1, ADR-0133): a broadcast that *does* touch the owner's world demoted to a passing line. Each demotion carries its evidence in the signal, so the eval lane can grade the fold against real corpus cases before the composer ever reads it.
