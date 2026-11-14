# The evidence map: the model knows what it can find out

Status: draft for owner review, 2026-11-14. The decisions dated 2026-11-14 are owner direction from the grill on the core-agent handoff. Nothing is merged yet.

Read first: [README principles](./README.md#2-the-principles), [memory.md §2](./memory.md#2-the-frame) (the frame), [ADR-0124](../decisions/ADR-0124-code-mode-is-the-chat-read-path.md) (Code Mode as the read path), and the [probe table §6](../research/user-questions-probe-table-2026-11-14.md) (the source of this theory).

---

## 1. The job

**When the model judges — a label, a matter, a remark, a claim, a pattern — it gathers evidence from the stores of every integration (principle 4). The gather works only if the model knows where the evidence can be.** The evidence map is that knowledge: which stores exist, how far back each reaches, what each can answer, and what each cannot.

The model does not hold the map in its weights, and it does not pay a search to find out where evidence lives. The map is pre-stated: a compact map in the prompt says where evidence can be, and Code Mode type declarations say what each store lets the program read. With the map, the model can count, order, and compare the raw record at judgment time, and it knows what it cannot learn.

**The fault that started this theory.** The A56 case (probe P1, 2026-11-12/13): an order confirmation, setup prompts, and a delivery notice sat quiet while nine sign-in echoes went `urgent`. The pieces of the matter were all in the stores. What was missing was the knowledge that they could be joined — that activity, mail, and state changes each reach far enough to hold both halves. The owner's direction (probe §6): the foundation is not a pattern store. It is that the model knows what it can find out.

**The worst errors**, in order:

1. The map states a reach that the store does not have. The model trusts it, and a wrong conclusion looks grounded.
2. A store exists and the map does not name it. The gather does not look, and Alfred misses a link that it would have found — the cheapest error of the journal, made certain.
3. The two homes disagree — the compact prompt map and the types say different things. The model reads the wrong one.
4. The prompt map grows past compact, and every gather pays for it in tokens on every run.

## 2. The parts

**One map, every reader.** The triage gather, the journal pre-briefing pass, the memory check job, the chat read path, and the user model all read the same declarations. A feature that gathers does not write its own idea of the stores. Until Code Mode is built (#535), each gather hand-picks its slice, as the briefing composer's tools do today; the map is the shared declaration that they converge to.

**What a store entry carries:**

- **The shape.** What a Code Mode program can read from the store, in types (ADR-0124).
- **The reach.** From when the store holds evidence, in the words of the source. The reach is a fact about the source, not a guess: integration activity starts at connect; Gmail holds the user's mail from years before sign-in.
- **The gaps.** What the store does not hold, stated as plainly as the reach: no actor mark, no body, a retention window.
- **What it answers.** The question groups of the probe table that the store serves (Q-A what the user did, Q-B how he usually acts, Q-C what is live now, Q-D things and names, Q-E what he said).
- **The lineage.** What the store replaced, or what replaces it, with the ADR that decided the change. Prod holds old rows next to new entities until a migration runs, and the model that reads a legacy store must know which theory governs it. The lineage is not a claim to trust: every decision is in the ADRs, the repository history is public, and Alfred can read both — so a lineage annotation is a pointer that Alfred verifies from its own stores, not an assertion.

**The map lives in two homes, split by cost.** Owner decision, 2026-11-14, second pass: the harness is self-aware — it can work out which tables exist and what to query — but working it out at every judgment is time and token waste. So the cheap facts are pre-stated, and the expensive discovery is never paid twice:

- **The prompt carries the compact map:** each store, its reach, its gaps, and what it answers — the table in section 3, kept small. A gather starts knowing where evidence can be; it spends no step finding that out.
- **The types carry the shape:** what a Code Mode program can read, in signatures (ADR-0124). The model gets the shape when it loads the surface, at no extra cost.
- **Self-awareness is the fallback, not the path.** For a store the map does not name, the harness can still find it — that is what keeps worst error 2 recoverable. But the default is to read the map, and a store missed by the map is a fault of the map, not a prompt for the model to go exploring. This keeps the rule of [the runtime-capability decision map](../plans/runtime-capability-awareness-decision-map.md): runtime code inspection is never the default answer path.

One compact map serves every reader (the triage gather, the journal pass, the memory check job, the chat read path). A feature that gathers does not write its own idea of the stores. The map must stay compact: a prompt map that grows per feature is boilerplate by another name (principle 7).

## 3. The reach facts known today

Verified against the code on 2026-11-14. This table is the seed of the map; the Code Mode declarations carry it when they are built.

| Store | Reach | Gaps | Answers |
| --- | --- | --- | --- |
| Mail (`documents`) | Years back: Gmail holds mail from before sign-in | — | Q-A (sent mail), Q-E, source facts |
| Activity record (`observations`, ADR-0118) | From the integration connect | No actor mark; acts and state changes, not each delivery (forty CI webhooks on one branch are one change) | Q-A, Q-B |
| `event_receipts` | Every delivery, raw kinds kept (ADR-0097) | Gmail receipts hold no body; webhook bodies released after 90 days (`RECEIPT_PAYLOAD_RETENTION_MS`); no actor mark | Q-A |
| Object state | From connect | Exact ids only today ([memory.md §8](./memory.md#8-theory-state-and-code-state)) | Q-A, Q-D |
| Chat turns | From the first turn | No embeddings yet; context search does not read them ([journal.md §10](./journal.md#10-theory-state-and-code-state)) | Q-E, Q-C |
| Claims and name links | From first capture | Not built ([memory.md §8](./memory.md#8-theory-state-and-code-state)) | Q-D, Q-E, Q-B |
| Page snapshots | From cold start | Stored per run, not per claim | Q-B, Q-D |
| Alfred's own stores: ADRs, `decisions.md`, git history, run records | The life of the repository | Too large to load as text — read through the map, not dumped | Self-awareness |
| Canonical external sources (provider status pages, public registries) | Live, fetched on demand | Not Alfred's own data; a fetch can fail, and the map must say which source answers which provider | Confirming a claim from the outside (Q-A) |
| GitHub and Google reads | MCP only (ADR-0125, ADR-0126) | The allowlist gate refuses `mcp` (`packages/assistant/src/tool-runtime/internal/registry.ts:390`) — a store on the map but closed to Code Mode until the gate changes | Q-A, Q-D |

The GitHub-and-Google row is the honest edge case the map must carry: a store can be known and still unreachable. The map says so, so the gather does not waste a step, and the workflow rewrite can close the gap knowingly.

**The outside: canonical sources.** Owner direction, 2026-11-14: even when a provider's notice arrives by mail, the model should know the canonical source it can read to confirm it — `githubstatus.com` for GitHub incidents, the provider's own status page, a public registry. The model trusts a mail less than a source it can check. This is the lesson of the stock-mail fault (probe P6): thirteen sender addresses missed the registries. A canonical source is not a store Alfred owns — the map names it, with what it answers and how fresh it is, so a judgment can confirm instead of trust.

**The migrations known today** (each decided in its ADR; the map carries them as lineage):

- `user_facts` → **claims** (ADR-0123). The old table keeps its name until a code change renames it ([memory.md §3](./memory.md#3-the-parts)); a migration runs under [memory.md §10](./memory.md#10-order-of-work), not a new decision.
- `sender_priors` → **retired, no successor store** (principle 5: it counts the model's own labels; a pattern is a judgment over the raw record, probe §6).
- The confidence gate (`proposeFact` at 0.85) and the confirmed-only read rule → **superseded by claims with evidence and author** (ADR-0123, [memory.md §8](./memory.md#8-theory-state-and-code-state)).
- A matter from chat → **a journal entry, not a loop** (ADR-0122 decision 3d). Not a table migration; a redirect that keeps a future migration honest.

## 4. What the map is not

**Not evidence.** The map says where evidence lives. The evidence is the raw record, and a judgment cites the record, never the map (principle 5, as [journal.md §3](./journal.md#3-the-parts) says for entries).

**Not a pattern store.** Owner direction, 2026-11-14 (probe §6): a habit is how often something happens against when it is expected, and the case decides what is relevant. The model comprehends this from the raw record at judgment time, through the gather that the map makes possible. No fixed series of steps finds a habit. At most, a stable pattern is cached — open (section 9).

**Not blind to the kind of habit.** A habit can be chosen (working at 1 am) or imposed (a bank OTP at each login). The model weighs which kind it is. The map serves this by stating each store's actor gaps: where no row marks its actor, "did the user do this" (Q-A) stays a model judgment over the raw record, not a column to read.

## 5. Alfred on the map

The parked self-awareness item of [memory.md §9](./memory.md#9-not-settled) resolves here. Alfred knows its own code, its changes, and the direction of its improvement the same way it knows the user's life: its stores are rows on the map (the ADRs, `decisions.md`, the git history, the run records of [memory.md §7](./memory.md#7-observability-how-memory-quality-is-measured-over-time)). Owner direction, 2026-11-14: the migration story of every store is part of this — each decision lives in an ADR, the repository history is public, and Alfred can read both, so it can work out not only what a store holds but when it got that shape and which decision put it there. The lineage annotations of section 3 are therefore verifiable from Alfred's own stores, not owner assertions to trust. The tension that the parked item named is settled by the split of section 2: the harness can work out what to query on its own, but the default is to read the map, and [the runtime-capability decision map](../plans/runtime-capability-awareness-decision-map.md) keeps its rule — inspection is never the default answer path.

## 6. What the model owns, and what code owns

| Question | Owner |
| --- | --- |
| Which stores to read for a judgment, and in what order | Model |
| Whether a pattern holds, and whether it is chosen or imposed | Model |
| Whether something is strange enough to say (with the journal's tone rules) | Model |
| The compact prompt map stays compact and matches the sources | Code (gate) |
| The declarations exist, compile, and name only real stores | Code |
| The prompt map and the types stay in agreement | Code (gate) |
| A gather cites the stores it read, and the ledger shows it | Code |

## 7. Theory state and code state

| Part | Theory | Code | The gap today |
| --- | --- | --- | --- |
| The map in the prompt and in the types | Settled (owner, 2026-11-14) | Not built | Waits on Code Mode (#535) |
| One map shared by every gather | Settled | Partly | Each gather hand-picks its slice today (the composer's tools) |
| Alfred's own stores on the map | Settled (resolves the parked item) | Not built | Self-identity grounding gives hosts, not the repository |
| Pattern cache in the durable profile | Open | Not built | Section 9 |

## 8. Order of work

1. **Code Mode (#535).** The map has no home without it (ADR-0124).
2. **The compact prompt map and the declarations,** from the table in section 3. The first reader is the triage gather, built end to end on the A56 case (probe P1, probe §7).
3. **Alfred's own stores on the map,** and the self-awareness item closed in [memory.md §9](./memory.md#9-not-settled).
4. **The pattern-cache decision,** after the first gather has run (section 9). Decide from evidence, not before.

## 9. Not settled

- **The pattern cache.** Whether a stable pattern is cached in the durable profile so the cheap first call reads it, or the first call gathers without it (probe §6 Q2). Owner direction leaves it "at most a cache"; the decision waits for the first gather to show whether the cheap call needs it.
- **"Strange enough" beyond the tone rules.** The journal's impact-and-certainty rules govern the wording, and the push carries only what needs the user's side (owner, 2026-11-14, [core-agent.md](./core-agent.md)). Whether anything more is needed is open until remarks run in production.
- **Embeddings over the activity record.** The pre-briefing pass scans what came in since the last pass, so it needs none; patterns come from Code Mode over the raw record. The open case is recall from chat ("have I had mail from this person before?"). Chats embed first; activity embeddings wait for a recall miss that shows the need (owner direction, 2026-11-14).
