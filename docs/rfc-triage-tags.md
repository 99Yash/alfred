# RFC — Triage tags as a Replicache-native, user-overridable surface

**Status:** Implemented v1 (Replicache read model + web hook/chip menu + override mutator + async Gmail relabel)
**Surface:** "Tags" = the per-thread `email_triage.category` label, surfaced to the web client over Replicache so the user can **read it live** and **override it**. Replicache-native; no new HTTP routes.
**Relates to:** ADR-0025 #1 (triage), ADR-0050/0051 (todos, triage v3), ADR-0034 (Replicache sync model).

---

## 0. Domain model & invariants

### What a "tag" is

A **triage tag** is the single alfred category currently on a Gmail thread. It already exists: one `email_triage` row per `(user_id, source_thread_id)`, mirrored into Gmail as one `Alfred/<Name>` label on the thread's canonical (latest-classified) message. Today it is **write-only from the classifier's side** and read by the UI only through a join in `GET /api/me/inbox`. This RFC gives the tag its own synced identity and a user-authored write path.

### Actors & resources

- **Classifier** (the `email-triage` workflow) authors and re-authors tags automatically (`source = 'auto'`).
- **User** overrides a tag to a category they prefer (`source = 'user'`).
- A tag belongs to a **thread** (`source_thread_id`), points softly at the latest classified **document**, and reflects an **applied Gmail label**.

### State machine (the `source` axis)

```
                 classifier writes (upsert)
   (no row) ───────────────────────────────▶  auto
                                               │  ▲
                       user override           │  │  classifier re-classify
                  ┌────────────────────────────┘  │  (see Invariant 5 — blocked
                  ▼                                │   while source = 'user')
                user  ───────────────────────────┘
                  │   (triageTagClear → re-open auto; deferred, §"rejected")
```

`category` moves freely within `TRIAGE_CATEGORIES` on each transition; `source` is the load-bearing state.

### Invariants (numbered — each maps to a type or a DB rule)

1. **One tag per thread.** PK `(user_id, source_thread_id)` already enforces this in PG; Gmail's thread-label collapse (apply-label step) enforces it in Gmail. The synced entity is keyed by `source_thread_id`, so the client store inherits it.
2. **`category ∈ TRIAGE_CATEGORIES`** always — enforced by `triageCategorySchema` (zod) at the mutator boundary and by the serializer.
3. **An `auto` tag carries classifier provenance** (`confidence ∈ [0,1]`, `rationale`, `classifiedAt`). A `user` tag does **not** — its confidence is meaningless and must never render. → discriminated union on `source` (Phase 3).
4. **`overridden_at` is set iff `source = 'user'`.** A NULL `overridden_at` on a `user` row, or a non-NULL one on an `auto` row, is illegal. → encoded in the union; the DB column is nullable but the serializer refuses the contradiction.
5. **A user override is sticky.** Once `source = 'user'`, the classifier must not silently overwrite `category`. (Policy choice — see Open Question 1; the _contract_ is stable regardless of which sticky-policy we pick.)
6. **`applied_label_id` reflects Gmail.** It is reconciled by exactly one code path (`reconcileThreadLabel`) under the per-thread advisory lock, whether the writer is the classifier or a user override. A fresh classifier rewrite or user override clears it to `NULL` until that shared writer confirms the new Gmail label. No second label-writer.

### Domain failure modes

- **Override targets a thread with no tag yet** (race: user clicks before first classify, or on an untriaged thread) → mutator no-ops server-side; nothing to relabel.
- **Gmail modify scope not granted** → the DB override still commits (the tag is our truth); the relabel job fails soft and retries; the thread's Gmail label lags until reconnect. Surfaced like `/inbox/mark-read`'s 409, but async.
- **Gmail label write fails / thread gone** → relabel job retries (BullMQ backoff); idempotent (re-reads the row, re-applies).
- **Concurrent override + classifier re-classify on the same thread** → serialized by the existing `triage:thread:<user>:<thread>` advisory lock; Invariant 5 decides the winner deterministically.

---

## 1. Library capability map

| Concern                                    | Blessed primitive (from ground truth)                                                              | Where                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Synced entity registry                     | `IDB_KEY.<SLUG>({id})` one-liner; `satisfies Record<IDBKeys, EntityFetcher>` forces a fetcher      | `packages/sync/src/keys.ts`, `…/replicache/entities.ts:346` |
| Read model → client                        | `ENTITY_FETCHERS.<SLUG>` returning `{id, rowVersion, serialized}`; generic CVR diff loop           | `…/replicache/pull.ts:88`, `entities.ts:104`                |
| Discriminated union read schema            | `z.discriminatedUnion("source", [...])` — same family as `senderContextSchema` / `AgentRunTrigger` | `packages/contracts/src/triage.ts`, `sync/src/schemas.ts`   |
| Optimistic client write                    | `<entity><Action>Client(tx, args)` reading/writing `IDB_KEY` k/v; bump `rowVersion`                | `sync/src/mutators/todos.ts`                                |
| Server write (atomic w/ LMID)              | `serverMutators.<name>(tx, args, ctx)` inline against the push `tx`, `rowVersion: sql\`+1\``       | `…/replicache/server-mutators.ts`                           |
| After-commit side effect keyed by mutator  | `POLICY_BUST_MUTATORS` set → fire after `tx` commits                                               | `…/replicache/push.ts:26,178`                               |
| Per-thread serialization across DB + Gmail | `withTriageThreadLock(userId, threadId, fn)` (`pg_advisory_xact_lock`)                             | `…/triage/store.ts:40`                                      |
| Gmail label convergence                    | `applyTriageLabel` + `findThreadSiblingsWithAlfredLabels` (Gmail is source of truth for siblings)  | `packages/integrations/src/google/labels.ts:241`            |
| Async reconcile job                        | BullMQ `IngestionJobData` discriminated union + worker                                             | `…/integrations/queue.ts`                                   |

**Reuse over custom.** Nothing here is new machinery: the override is a Replicache mutator (like `factConfirm`), the after-commit relabel mirrors `POLICY_BUST_MUTATORS`, and the Gmail write reuses the _exact_ body of the existing `apply-label` step — extracted into `reconcileThreadLabel` so the classifier and the override path converge through one function (Invariant 6).

---

## 2. Worked call sites (the ideal, iterated)

### Client — override a tag (happy path is one call)

```ts
const { overrideTag } = useTriageTags();
// User picks "Action" on a thread Alfred tagged "fyi":
await overrideTag(threadId, "action_needed");
// Optimistic: the chip flips instantly to a USER tag (no confidence shown);
// the relabel job converges Gmail within seconds. Next pull rebases.
```

### Client — read (the union makes the wrong render not compile)

```ts
const tag = useTriageTag(threadId); // SyncedTriageTag | undefined
if (tag?.source === "auto" && tag.confidence < 0.5) {
  // ✅ confidence only exists on the auto branch
  showSoftConfirm(tag);
}
// tag.source === "user" ? tag.confidence  // ❌ does not compile — property absent
```

### Server — the override mutator (inline against the push tx)

```ts
async triageTagOverride(tx, args, ctx) {
  await tx.update(emailTriage)
    .set({ category: args.category, source: "user", overriddenAt: new Date(),
           rowVersion: sql`${emailTriage.rowVersion} + 1` })
    .where(and(eq(emailTriage.userId, ctx.userId),
               eq(emailTriage.sourceThreadId, args.threadId)));
  // No-op if the row is absent (override before first classify). No Gmail IO here.
}
// push.ts, after commit: for each applied override, enqueueTriageRelabel(userId, threadId)
```

### Server — the one label-writer both paths share

```ts
// classifier apply-label step AND the relabel job call this:
await reconcileThreadLabel({ userId, sourceThreadId });
// Holds the thread lock, reads the (now canonical) row, applies its category
// to the canonical message, strips siblings, persists applied_label_id.
```

---

## 3. The typed contract

### Domain types (discriminated union — Invariants 3 & 4)

```ts
type SyncedTriageTag =
  | {
      source: "auto";
      threadId;
      userId;
      category: TriageCategory;
      confidence: number;
      rationale: string | null;
      classifiedAt: string;
      documentId: string | null;
      appliedLabelId: string | null;
      rowVersion: number;
      updatedAt: string | null;
    }
  | {
      source: "user";
      threadId;
      userId;
      category: TriageCategory;
      overriddenAt: string;
      documentId: string | null;
      appliedLabelId: string | null;
      rowVersion: number;
      updatedAt: string | null;
    };
```

The `auto` branch has `confidence`/`rationale`/`classifiedAt` and no `overriddenAt`; the `user` branch has `overriddenAt` and none of the classifier provenance. An illegal mix fails to compile (see `triage-tags.type-test.ts`).

### Error model (closed)

```ts
type TriageTagError =
  | { kind: "no_tag_for_thread" } // override before first classify → mutator no-op
  | { kind: "relabel_scope_missing" } // Gmail modify scope absent → DB committed, label lags
  | { kind: "relabel_thread_gone" } // thread/doc vanished → job finishes, no write
  | { kind: "relabel_transient" }; // Gmail 5xx / token blip → BullMQ retries
```

Only `relabel_*` originate in the async job (logged + retried, never surfaced synchronously). `no_tag_for_thread` is absorbed as a server-side no-op — Replicache mutators don't return values to the caller, so it cannot become a client error envelope by construction.

### Mutator arg schema

```ts
const triageTagOverrideArgsSchema = z.object({
  threadId: z.string().min(1).max(200),
  category: triageCategorySchema,
});
```

### DB additions to `email_triage` (additive, nullable/defaulted — zero-downtime)

| Column          | Type                                                   | Notes                                 |
| --------------- | ------------------------------------------------------ | ------------------------------------- |
| `source`        | `text NOT NULL DEFAULT 'auto'` `$type<'auto'\|'user'>` | the state axis (Invariant 5)          |
| `overridden_at` | `timestamptz NULL`                                     | set iff `source='user'` (Invariant 4) |
| `row_version`   | `integer NOT NULL DEFAULT 0`                           | Replicache CVR diffing                |

No index change: the pull fetcher filters by `(user_id)` + the existing `email_triage_user_classified_idx` covers the recency bound.

---

## 4. The surface

**No new HTTP routes.** Reads ride the existing Replicache pull; the write is a mutator; Gmail convergence is a queued job. `GET /api/me/inbox` is unchanged — the synced tag _overlays_ the document list client-side by `threadId`.

### Synced entity

| Field        | Value                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slug         | `TRIAGE_TAG`                                                                                                                                                              |
| IDB key      | `triagetag/{threadId}` (id = `source_thread_id`)                                                                                                                          |
| Pull window  | `source='user'` always; `source='auto'` within 30d of `classified_at` AND category ∉ {newsletter, marketing} (mirrors `RAIL_SUPPRESSED_CATEGORIES`). See Open Question 2. |
| `rowVersion` | `email_triage.row_version`                                                                                                                                                |

### Mutators

| Name                | Args                   | Client (optimistic)                                                                            | Server (inline `tx`)                                                                                                      | After-commit                                                                                      |
| ------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `triageTagOverride` | `{threadId, category}` | flip local row → `user` variant, drop confidence/rationale, set `overriddenAt`, `rowVersion+1` | `UPDATE email_triage SET category, source='user', overridden_at=now, row_version+1 WHERE (user,thread)` — no-op if absent | `enqueueTriageRelabel(userId, threadId)` (via `RELABEL_MUTATORS`, mirrors `POLICY_BUST_MUTATORS`) |

### Internal service (`packages/api/src/modules/triage/tags.ts`)

```ts
reconcileThreadLabel(args: { userId; sourceThreadId }): Promise<ReconcileResult>
enqueueTriageRelabel(userId: string, sourceThreadId: string): Promise<void>
```

`reconcileThreadLabel` is the **extracted body of the existing `apply-label` step** — the classifier workflow calls it instead of its inline block, and the relabel job calls it too. One label-writer, two callers (Invariant 6).

### Queue

New `IngestionJobData` variant `{ kind: "triage.relabel"; userId; sourceThreadId }` → worker calls `reconcileThreadLabel`. Same retry/backoff as ingestion; idempotent.

### Status mapping

N/A for the sync path (no HTTP). The async job logs the `TriageTagError` kind; `relabel_scope_missing` is the only user-actionable one and is reflected the same way Gmail-scope gaps already are in the rail ("Reconnect Gmail").

---

## 5. Red-team

| Risk                                                               | Design answer                                                                                                                                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Misuse: override an arbitrary string category**                  | `triageCategorySchema` rejects at the mutator boundary; never reaches SQL. Compile-time too (`TriageCategory`).                                                                                     |
| **Misuse: render confidence on a user tag**                        | Union — property absent on `user`; does not compile.                                                                                                                                                |
| **Misuse: a second Gmail label-writer drifts from the classifier** | There is only one writer, `reconcileThreadLabel`; both paths call it under the same thread lock.                                                                                                    |
| **Race: override vs concurrent classify**                          | Advisory lock serializes; Invariant 5 (sticky) decides. The relabel job re-reads inside the lock, so whoever runs last reproduces the same single tag.                                              |
| **Double-submit / Replicache at-least-once**                       | Override is idempotent (set to the same category twice = same row, `rowVersion` advances harmlessly). Relabel job is idempotent. LMID advance prevents re-apply.                                    |
| **Hyrum: clients depending on `confidence` always present**        | The union _removes_ it on `user` — clients are forced to branch on `source` from day one, so no code can latch onto an always-present `confidence`.                                                 |
| **Scale: pull volume of tags**                                     | Bounded by the 30d + non-suppressed window. Single-user; worst case a few hundred rows. Covered by `email_triage_user_classified_idx`. Open Question 2 if a user wants to override suppressed mail. |
| **Billable work in a Promise.all**                                 | None — the override does no LLM call. The relabel job does only Gmail label IO, off the request path.                                                                                               |
| **Override before first classify**                                 | Mutator no-ops (WHERE matches nothing); the eventual classify writes `auto`; user can override again. No orphaned state.                                                                            |

---

## 6. Alternatives considered & rejected

1. **HTTP `PATCH /api/me/triage/:threadId` instead of a mutator** — rejected: breaks the Replicache-native mandate, loses optimistic UI, and forks the write model. Every other user-authored entity (todos, facts, prefs, policy) is a mutator; a REST tag write would be the lone exception.
2. **Do the Gmail label write inside the mutator** — rejected: mutators run inside the push DB transaction; external IO (Gmail) cannot be transactional and would block the push. After-commit enqueue mirrors the proven `POLICY_BUST_MUTATORS` pattern.
3. **A separate `triage_tag_overrides` table** — rejected: the tag already lives in `email_triage` keyed per thread; a parallel table duplicates the PK and reintroduces the two-writer drift Invariant 6 forbids. Add `source`/`overridden_at` to the existing row instead.
4. **Boolean `is_user_override` + `category`** — rejected: representable illegal state (`is_user_override=true` with classifier `confidence` still rendered). The `source` discriminant + union forbids it.
5. **`triageTagClear` (revert to Alfred) in v1** — deferred: clearing has no optimistic category to show (we overwrote the auto category), so it must enqueue a fresh classify+relabel — a different shape. Designed in §"future" but kept out of the v1 skeleton to stay minimal. Tracked as Open Question 3.
6. **Sync every category (incl. newsletter/marketing)** — deferred behind Open Question 2: the rail hides bulk mail, so syncing it spends CVR budget on tags the user can't see. Start non-suppressed; widen if override-on-bulk is wanted.

---

## 7. Rollout

1. **Migration** (additive, reversible): `pnpm db:generate` → `db:migrate` adds `source`, `overridden_at`, `row_version` to `email_triage`. Defaults backfill existing rows to `auto`/`0` with no rewrite (PG fills defaults lazily for `NOT NULL DEFAULT`). **Never `db:push`.**
2. **Refactor first, ship behind nothing:** extract `reconcileThreadLabel` and point the `apply-label` step at it — pure refactor, no behavior change, lands independently and is the lower-risk half.
3. **Then wire the entity + mutator + job.** New synced entity is additive; old clients ignore an entity slug they don't read.
4. **No rate-limiter `categorize` entry** needed (no new HTTP path). The relabel job inherits ingestion-queue limits.
5. **Versioning:** the union is additive-safe — a future `source: 'agent_suggested'` variant is a new union member, not a breaking change, as long as clients already branch on `source` (which the union forces).

---

## 8. Open questions for the human

1. **(Blocking the upsert body, not the contract) Sticky policy for Invariant 5.** When a user has overridden a thread and a _new inbound message_ arrives, does the classifier (a) leave the user's tag forever, (b) re-open auto classification because the thread genuinely changed, or (c) keep the user tag but shadow-log Alfred's new opinion? Recommend **(a)** for v1 — most predictable, easiest to explain, "Alfred respects my choice." This only affects the `upsertTriage` guard logic; the columns/union are identical across all three.
2. **Pull window for suppressed categories.** Sync `auto` newsletter/marketing tags so the user _can_ override them, or keep them out of the client store (cheaper, matches the rail)? Recommend out for v1.
3. **Ship `triageTagClear` (revert to Alfred) in v1 or defer?** Recommend defer — override alone covers the painful case; revert needs a re-classify enqueue and has no optimistic story.
4. **Does an override count as a learning signal?** Should a user override bump the sender prior / feed ADR-0051 observations (the user telling Alfred "this sender's mail is action_needed, not fyi")? Out of scope here, but the data is now first-class if we want it.
