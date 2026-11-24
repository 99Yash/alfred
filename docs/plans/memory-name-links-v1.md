---
status: superseded
evidence: "Plan only (owner decision 2026-11-23). No code, migration, or infra change exists yet. Superseded 2026-11-24 by the draft theory docs/theory/resolution.md (owner decision): names that a source or the config states are read in place, so the boot writer and the self and repository nodes of this plan are not needed. Revise this plan after resolution.md is settled."
---

# Memory name links v1 — step 2 of ADR-0123

Step 2 of [memory.md §10](../theory/memory.md#10-order-of-work): name links, and Alfred itself
as a thing. The theory is settled in [memory.md §3](../theory/memory.md#3-the-parts) (the parts)
and [§4](../theory/memory.md#4-resolve-a-name-at-the-start-of-a-turn) (the lookup). This plan
records the implementation decisions, the owner correction that shaped them, and the order of
attack. The turn-start lookup and its resolution log are step 3 and are not here.

Status: **proposed, not built**. The owner chose plan-only review on 2026-11-23.

## Why this exists

The 2026-11-08 fault (memory.md §1): the user asked chat for "alfred's issues" (prod run
`run_s7yi1ymxakcj`). Alfred held the GitHub login and 94 PR rows for `99Yash/alfred`, but nothing
could resolve the name, because `context-search/object-state-source.ts` reads exact ids only.

Step 1 (PR #1897) built the claim row. Step 2 builds the second note kind of memory.md §2: the
name link. A name link is the word the user or a source uses for a thing, linked to that thing,
with the claim shape: evidence, author, producer, validity, and (later) the check.

## The owner correction that shapes the design

2026-11-23, on the first draft: the owner gave the example "my wife's name is Rosamund but I call
her Rosie", and said the design must not let the GitHub example cripple it. The rule for the whole
area: **design from the general model, not from the first example.** The general model has three
layers, and the name link is the third:

1. **The thing** — Rosamund. One thing. The context graph holds it: an `entity_nodes` row (person,
   service, repository, referent) or an `integration_objects` row (a thing with provider state).
2. **The identities** — the keys that pick the thing out: her mail address (one of possibly
   several), her phone. An identity is not always unique in the world (a family mailbox names two
   people), and one thing can hold several. `entity_identities` owns this layer today, with typed
   kinds, per-kind canonical form, and the `(user, kind, value)` active-unique law. The
   `EntityIdentityConflictError` of `knowledge/entities.ts:62` is the guard that makes the writer
   resolve a shared mailbox instead of merging two people.
3. **The names** — "Rosamund", "Rosie", "love of my life". Not identities: not unique, not
   canonical. A name link points at the thing, never at an identity value and never at a GitHub
   special case. The thing carries the identities.

Consequence: `name_links.thing` is a plain record pointer. A writer that must point at a thing
with no record mints the record first (context-graph.md §Projection: "`entity_nodes` and
`entity_identities` stay as stable records, which a writer makes when something must point at a
thing"). Alfred itself and its repository are things like any other, so they get records.

## Implementation decisions

These choices are not in the ADR or the theory page. Each is the smallest choice that keeps a
theory rule.

### 1. A new `name_links` table, not `entity_identities`

A name is not unique and not canonical, so the active-unique `(user, kind, value)` law of
`entity_identities` (migration on `user-model.ts:245`) cannot hold for names: "alfred" must name
two things. The new table keeps the claim shape of step 1 instead:

- `id` (`nl_` prefix), `user_id` (FK `user`).
- `display_value`: the name as written ("Rosie", "Alfred", "99Yash/alfred").
- `normalized_value`: lowercase, trimmed. One local helper `normalizeName()` next to the write
  boundary, modeled on `comparable()` in `knowledge/claim-evidence.ts:54`. The lookup of step 3
  reuses it, so capture and matching fold the same way.
- `thing`: jsonb tagged union, exactly one arm set:
  - `{ kind: "entity", entityId }` — FK `(user_id, id)` to `entity_nodes`;
  - `{ kind: "integration_object", objectId }` — FK `(user_id, id)` to `integration_objects`.
- `evidence`: `claimEvidenceListSchema` plus one new kind (decision 4).
- `author`: `claimAuthorSchema`. `producer`: `claimProducerSchema`. Both reused from
  `contracts/src/memory.ts` unchanged.
- `valid_from` nullable (the start is often unknown; the config does not say when the repository
  got its name), `valid_until`, `supersedes_name_link_id`, provenance and lifecycle dates.
- CHECKs: normalized value nonempty and unpadded; the thing union is exactly one valid arm; an
  active row cites at least one evidence link; the validity window; no self-supersede.
- Indexes: `(user_id, normalized_value)` on active rows; the supersede pointer.

### 2. The thing record is made when a link needs it

No writer writes a name link at a thing that has no row. The runtime-config writer mints the self
node and the repository node at boot (decision 3). A later capture path mints or matches the
person node by an identity, then writes each name with its evidence.

### 3. The self and the repository get `entity_nodes` rows

The ownership table (context-graph.md) gives a service and a repository `entity_nodes` as their
one record. Minting needs a permanent identity anchor, and Alfred has none that exists today:

- **A new identity kind `self`**, value fixed at `alfred`. One entry in
  `FORWARD_IDENTITY_KINDS` (`contracts/src/user-model.ts:141`) and one format in
  `IDENTITY_VALUE_FORMATS` (`:241`). Canonical form: trim, no case fold.
- **`github_repository_full_name` moves from forward to written.** The contracts law says the
  first writer moves a forward kind into its own `identityKinds`; the runtime-config writer is a
  non-reducer writer, so the law's wording widens to "the first writer that starts to write one
  moves it". No `entity_identities` row is needed for the self or the repository: the node's
  `canonical_identity` suffices, and no identity-matching reader exists for them.
- **`ENTITY_ID_NAMESPACE` goes to prod infra** (`infra/src/services.ts`, one env line). The mint
  refuses to run without it (`db/src/helpers.ts:100`), and repository names are guessable, so the
  refusal is the guard that keeps `ent_*` ids unguessable.
- `ensureEntityNode` (`knowledge/entities.ts:27`) is the mint path, reused unchanged. It
  converges `first_seen_at` with LEAST, so a redeploy cannot drift it.

### 4. One new evidence kind: `runtime_config`

The evidence union of step 1 points at the raw record (chat, mail, activity, page). The runtime
config is not in that list, and memory.md §3 makes config a name-link writer ("is evidence from
config, not a rule for one kind"). The kind carries the env var names that state the fact:
`{ kind: "runtime_config", vars: ["ALFRED_DEPLOYED_REPO_OWNER", …] }`. The check job of step 6 can
re-read a config value at its commit.

### 5. The writer: one deterministic path, no model

`ensureSelfNameLinks()` runs once per boot on the worker runtime, idempotent, insert-if-missing:

- Names of the self: "Alfred", the web host, the API host, the GitHub App slug, the send address —
  each → the self node. Evidence: `runtime_config` items for the vars behind each name.
- Names of the repository: `owner/name`, and the bare name after the slash — each → the
  repository node. "alfred" therefore matches two things; the lookup of step 3 asks the user when
  the context cannot pick (ADR-0099). The ambiguity is intended.
- Author `agent`; producer pipeline `self-name-links`, commit `deployedCommitSha()`, model null.
- A changed host does not update the old row at boot; the check job of step 6 retires stale rows.
  The writer only fills what is missing.

### 6. No proposed/confirmed cycle for name links

The theory gives a confirm rule to claims only (memory.md §9 Q6). A name link has no
`proposed`/`confirmed` status. A wrong link's guard is at resolution time: the lookup returns
candidates, the model asks the user when the context does not pick. The check job checks links
like it checks claims (step 6). A user-asserted link (step 4, chat capture) cites a chat turn and
wins over an agent link of the same name.

### 7. What this slice does not build

- The turn-start lookup, the matching (including `pg_trgm`), and the resolution log: step 3. The
  2026-11-08 trace stays the eval case for it.
- Person names from mail and activity: a later slice, after the people path settles (ADR-0127 is
  still moving that substrate; the only live node writers are the Gmail folds).
- Chat capture with the quote check: step 4. Page snapshots: step 5. The check job: step 6.
- `integration_object` name links: the FK arm exists in the schema; no writer needs it yet.

## Rejected shapes

- **A tag inside the name-link row** (`{ kind: "self" }`, `{ kind: "github_repository", … }` as
  literal arms). Rejected by the owner correction: it special-cases the first example, and it
  leaves the self and the repository without thing records, against the context-graph rule.
- **Reusing `entity_identities` for names.** Rejected: the active-unique law cannot hold for a
  non-unique, non-canonical value.
- **A proposed/confirmed cycle for links.** Rejected: the theory gives it to claims only, and the
  resolution-time ask covers the worst error ("acts on the wrong thing").
- **`pg_trgm` in this slice.** Deferred to step 3, where the lookup needs it; no table today has
  the extension.

## Amendment to file with the PR

ADR-0123 gains a "2026-11-23" amendment: name links point at thing records; the runtime config is
a non-reducer writer that mints the self node (identity kind `self`) and the repository node
(identity kind `github_repository_full_name` moves from forward to written); `name_links` carries
no confirm cycle. `decisions.md` and memory.md §8 get the same one-line updates. The theory page
rows for "Name links" and "Alfred itself as a thing" move to Built when the PR lands.

## Residual risks

- The self node has no kind column (`entity_nodes` has none; context-graph confusion #5 stays
  open). The identity kind `self` marks it. A reader that needs a kind before that question
  settles must not read name links.
- ADR-0127 is still reshaping the node substrate. The self and repository nodes are plain
  `entity_nodes` rows, so a substrate change moves them with everything else.
- The bare-name link ("alfred" → the repository) is written from config only for the self
  repository. A second repository named "alfred" would be ambiguous by design, and the lookup
  asks.
- `ENTITY_ID_NAMESPACE` on prod is a deploy step: the merge without the env makes the boot writer
  refuse (and the rest of boot must not depend on it — the writer runs, catches, and logs).

## Order of attack in the PR

1. Contracts: the `self` identity kind, the `runtime_config` evidence kind, the widened
   first-writer law note.
2. DB: migration 0187 (`name_links`), the row type, the `normalizeName` helper.
3. Assistant: the self/repository mint and `ensureSelfNameLinks()`, wired at worker boot.
4. Tests on a scratch DB (Docker DB down today: Homebrew Postgres on 5433 plus a temporary Redis,
   per the step-1 handoff), `pnpm check`, `pnpm check-types`.
5. Docs: the ADR-0123 amendment, memory.md §8 rows, decisions.md, and this plan's status.
