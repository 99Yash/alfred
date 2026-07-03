# Runbook: activating the Gmail user-model kind projection

**Epic:** #218 (evolving user-model spine). **Design:** [user-model-p1-gmail-shadow.md](../plans/user-model-p1-gmail-shadow.md) / ADR-0067.

This runbook operationalizes the **first manual activation** of the ADR-0067
Gmail kind projection — the first activated projection-backed read model. It is
the keystone that turns on work that is already shipped but **dormant**: the
triage consumer (`resolveSenderKind`, PR I) is a no-op until a projection is
activated for the user.

## What activation does (and does not do)

Activating flips `active_projection_versions.active_run_id` to a completed
projection run. Once active:

- `userModelReader(userId).getProfileByIdentity(...)` returns the folded
  `entity_profiles` for that user.
- Triage's `resolveSenderKind` reads those profiles and **demotes person
  treatment for confident `group`/`service` senders only** (kind in
  `{group, service}` AND `confidence >= 0.8` — `TRIAGE_SENDER_KIND_CONFIDENCE_THRESHOLD`).

It deliberately does **not**:

- Demote on absence of data, or on a weak/`unknown` classification (a bare
  `engineering@`/`team@` alias with no list header stays `unknown` at 0.58 and
  never demotes — only an authoritative `List-Id`/`List-Unsubscribe`/`Precedence:
  bulk|list` header promotes to confident `group` at 0.99).
- Write significance, edges, co-occurrence, or reciprocity (deferred; kind-only
  slice).
- Change any stable entity id (ids are content-addressed off `ENTITY_ID_NAMESPACE`
  and are version-independent; re-folding a new version only rewrites
  `entity_profiles.kind`/provenance).

## Preconditions (hard gates — do not skip)

1. **`ENTITY_ID_NAMESPACE` is set on Railway** (`server` service), ≥32 chars, no
   surrounding whitespace, and **backed up like an auth secret**. Changing it
   re-mints every content-addressed entity id on the next replay. Every writer
   routes through `requireEntityIdNamespace()`, which fails loud if it is unset —
   so a missing value cannot silently mint weak ids, but it also blocks the run.
   Verify before starting:
   ```bash
   railway ssh -s server
   node -e "console.log(!!process.env.ENTITY_ID_NAMESPACE && process.env.ENTITY_ID_NAMESPACE.length >= 32)"
   # expect: true
   ```
2. **Gmail observation backfill has been run at scale** for the target user
   (PR D). The fold replays `observations` where `source='gmail'` and
   `kind='email_message'`; with no observations there is nothing to fold. The
   projection script prints `active gmail observations=N` per target — confirm N
   is non-trivial.
   ```bash
   # dry preview first, then commit:
   node apps/server/dist/scripts/backfill-gmail-observations-committed.js --emails=yash.k@oliv.ai
   node apps/server/dist/scripts/backfill-gmail-observations-committed.js --emails=yash.k@oliv.ai --commit
   ```
   The Gmail **sent** backfill (PR B, `backfill-gmail-sent-committed.js`) feeds
   reciprocity/reply-latency, which are **deferred** in this kind-only slice —
   not required for activation, but harmless to have run.
3. **Local fixture validation is green** on the current tree (see below). The
   classifier and fold logic must be frozen and passing before any prod run.

## Step 1 — Local fixture validation (no prod access)

The activation gates are encoded as re-runnable tests. Run them against a local
Postgres (`DATABASE_URL` from `apps/server/.env`):

```bash
cd packages/api
export $(grep -E '^(DATABASE_URL|ENTITY_ID_NAMESPACE)=' ../../apps/server/.env | xargs)
npx tsx --test \
  test/user-model/entity-kind-classifier.test.ts \
  test/user-model/gmail-kind-fold.test.ts \
  test/user-model/gmail-kind-projection-gates.test.ts \
  test/contracts/user-model-writers.test.ts \
  test/triage/sender-kind.test.ts
# expect: pass, fail 0
```

Gate coverage (from the PR G validation gates):

| Gate | What it asserts | Where |
|---|---|---|
| 1 | Replay determinism — same input folds to the same checksum | `gmail-kind-projection-gates` (folds v1 vs v2, equal checksum) |
| 4 | List aliases (`List-Id`) classify `group`, never person-scored | classifier + gates |
| 5 | `noreply`/notification senders classify `service`, never person-scored | classifier + gates |
| 6 | Top person-scored profiles exclude lists/services; self excluded | fold + gates |
| 9 | Activation refuses a non-`completed` run | `user-model-writers` |
| 10 | The active reader returns the activated rows | fold + gates |
| — | Consumer bar: demote confident `group`/`service` only; weak alias never demotes | `sender-kind` + gates (`resolveSenderKind` end-to-end) |

Gates 2, 3 (observation count = eligible docs − skips; header-coverage
diagnostics) are validated at **backfill** time — the backfill script reports
fetched/inserted/skipped counts. Gates 7, 8 (legacy-coverage comparison,
reply/reciprocity plausibility) are deferred with the significance fold.

## Step 2 — Prod dry-run (writes nothing)

Dry mode folds the target twice inside rollback-only transactions and compares
checksums; it prints profile count, checksum, and Gmail high-watermark. Run on
the mailbox where the corruption was measured first.

```bash
railway ssh -s server
node apps/server/dist/scripts/project-user-model-gmail-shadow-committed.js \
  --emails=yash.k@oliv.ai --projection-version=1
```

Inspect the output:

- `active gmail observations=N` — non-trivial (precondition 2).
- `DRY validated — profiles=… checksum=sha256:… high_watermark=…` — a stable
  checksum means the two internal replays agreed (gate 1). If the determinism
  check fails, the run aborts — **stop and investigate**, do not commit.

## Step 3 — Prod commit (persist, do not activate)

`--commit` writes the completed projection run and re-checks that the committed
checksum/profileCount match the dry validation (it throws on divergence). It does
**not** flip the active pointer.

```bash
node apps/server/dist/scripts/project-user-model-gmail-shadow-committed.js \
  --emails=yash.k@oliv.ai --projection-version=1 --commit
# -> COMMITTED — run=prun_… profiles=… checksum=sha256:…
```

## Step 4 — Manual spot-check before activation

This slice's whole point is to fix the "list/service treated as person"
corruption, so eyeball the committed profiles for the target before flipping the
pointer. Query the committed run's `entity_profiles` (via `railway ssh` + a small
`node`/`pg` read, keyed on the `prun_…` id from Step 3):

- `engineering@oliv.ai` (and peers) classify `group` (with `List-Id` evidence) —
  **never `person`**.
- `noreply@…`, notification/alert senders classify `service` — **never `person`**.
- The top `person`-kind profiles are actual humans, not lists/services.
- The account's own address(es) have **no** profile (self is excluded).

## Step 5 — Activate (on explicit go-ahead)

> **Requires the user's go-ahead.** This is the go-live: it changes triage
> behavior for real inbound mail.

```bash
node apps/server/dist/scripts/project-user-model-gmail-shadow-committed.js \
  --emails=yash.k@oliv.ai --projection-version=1 --commit --activate
# -> ACTIVATED — user-model v1
```

`--activate` requires `--commit` and activates only a `completed` run
(`activateProjectionVersion`, gate 9). Sanity-check the second mailbox
(`yashgouravkar@gmail.com`) the same way before/after.

## Step 6 — Post-activation verification

- On the next triage of a distribution-list/service email from the activated
  user, the decision trace carries the sender-kind demotion breadcrumb
  (`senderKind`, `senderKindConfidence`, `senderKindDemotedPersonTreatment=true`,
  `knownContact=false`) — see `senderExtractionEvent`.
- Confirm no *person* sender lost treatment (the demotion is subtractive and
  gated at `confidence >= 0.8`, so this should not happen; verify anyway).

## Rollback / de-activation

Activation is a pointer flip on `active_projection_versions`. To revert:

- Re-point `active_run_id` to a prior completed run (if one exists), **or**
- Delete the `active_projection_versions` row for
  `(userId, 'user-model')` — with no active pointer the reader returns nothing
  and `resolveSenderKind` is a no-op (silent-graph = no demotion), restoring
  legacy behavior. The kill-switch preference
  `feature.internal.triage_sender_kind_projection = false` also disables the
  consumer read without touching the projection.

Completed runs are immutable (their checksum is what cutover trusts). To
re-project after a classifier change, **bump `--projection-version`** and repeat
from Step 2; never re-run a completed version.

## Re-fold policy (PR J — scheduled re-fold, not yet built)

- **First activation is manual** (this runbook).
- A scheduled re-fold (PR J) may **auto-activate** a new run only when the
  classifier logic is frozen and the determinism check passes; on checksum
  divergence it must **fail the run instead of activating**. A classifier-logic
  change requires a manual re-validation pass (Steps 1–5) — auto-activation is
  for frozen-logic refreshes over new observations only.

## Reference

- Projection/activation script: `apps/server/src/scripts/project-user-model-gmail-shadow-committed.ts`
  (prod bundle from repo root: `apps/server/dist/scripts/project-user-model-gmail-shadow-committed.js`).
- Observation backfill (prereq): `apps/server/src/scripts/backfill-gmail-observations-committed.ts`.
- Classifier: `packages/api/src/modules/user-model/entity-kind-classifier.ts`.
- Fold: `packages/api/src/modules/user-model/gmail-kind-fold.ts`.
- Lifecycle writers (start/complete/activate + guards): `packages/api/src/modules/user-model/projection.ts`.
- Consumer: `packages/api/src/modules/triage/sender-kind.ts`.
- Local gate test: `packages/api/test/user-model/gmail-kind-projection-gates.test.ts`.
