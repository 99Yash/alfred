import { canonicalizeFactKey, type IntegrationRules } from "@alfred/contracts";
import type { DbTransaction } from "@alfred/db";
import {
  chatMessages,
  chatThreads,
  emailTriage,
  notes,
  rejectedInferences,
  todos,
  userActionPolicies,
  userFacts,
  type UserFact,
  workflows,
} from "@alfred/db/schemas";
import type {
  ChatAttachmentCreateArgs,
  ChatMessageCreateArgs,
  ChatThreadCreateArgs,
  ChatThreadDeleteArgs,
  ChatThreadRenameArgs,
  ChatThreadSetPinnedArgs,
  FactConfirmArgs,
  FactCreateArgs,
  FactEditArgs,
  FactRejectArgs,
  MemorySource,
  NoteCreateArgs,
  PolicySetDefaultModeArgs,
  PolicySetIntegrationModeArgs,
  PrefDeleteArgs,
  PrefSetArgs,
  TodoClearArgs,
  TodoCompleteArgs,
  TodoCompleteSuggestionArgs,
  TodoCreateArgs,
  TodoDismissArgs,
  TodoEditArgs,
  TodoPromoteArgs,
  TodoReopenArgs,
  MutatorName,
  TriageTagOverrideArgs,
  WorkflowUpdateArgs,
} from "@alfred/sync";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { DEFAULT_APPROVAL_NOTIFY_DELAY_MS } from "../../action-policies";
import { isSingleValuedKey, valueSignature } from "@alfred/assistant/knowledge";
import { deletePreferenceRow, upsertPreference } from "@alfred/assistant/settings";
import {
  reviseWorkflowFromPatch,
  setWorkflowStatus,
  type WorkflowDefinitionPatch,
  type WorkflowServiceFailure,
} from "../../workflows";
import { MutatorForbiddenError } from "../authz";

/**
 * Baseline rules for a row that doesn't exist yet (legacy user predating the
 * signup seed). Must keep `system: autonomy` or system tools would start
 * gating — mirrors `ensureDefaultActionPolicyForUser` / `resolve.ts`.
 */
const DEFAULT_INTEGRATION_RULES: IntegrationRules = {
  system: { mode: "autonomy" },
};

export interface ServerMutatorCtx {
  userId: string;
}

// The push handler runs every mutator inside its outer transaction's savepoint,
// so a mutator's executor is always a `DbTransaction`, never a pooled `db()`
// handle. Typing it as such makes handing a pool to a mutator (re-forking the
// transaction, breaking atomicity) a compile error at the call site. A body that
// re-imports `db()` itself stays a code-review concern — the type only guards the
// executor that is passed in.
type DbTx = DbTransaction;

/**
 * Shape every server mutator must conform to. `args: never` lets each concrete
 * mutator keep its own precise arg type while still satisfying the map
 * constraint below. Paired with `satisfies Record<MutatorName, ServerMutator>`
 * on `serverMutators`, this makes a client mutator with no server impl a
 * compile error instead of a silent runtime drop in `push.ts`.
 */
type ServerMutator = (tx: DbTx, args: never, ctx: ServerMutatorCtx) => Promise<unknown>;

async function lockFactKey(tx: DbTx, userId: string, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))`);
}

function canonicalFactKey(rawKey: string): string {
  const canon = canonicalizeFactKey(rawKey);
  return canon.ok ? canon.key : rawKey;
}

/**
 * Turn a revision-service failure into the one error `push.ts` understands.
 *
 * The savepoint around each mutator rolls back on any throw, so a rejected edit
 * leaves no partial revision behind. `MutatorForbiddenError` is the right
 * carrier for all of these: none is retryable, and the client's optimistic
 * patch is discarded on the next authoritative pull either way.
 */
function workflowMutatorError(failure: WorkflowServiceFailure): MutatorForbiddenError {
  switch (failure.kind) {
    case "validation_failed":
      return new MutatorForbiddenError(failure.problems.map((p) => p.message).join(" "));
    case "builtin_immutable":
      return new MutatorForbiddenError("cannot edit a built-in workflow");
    case "no_current_revision":
      return new MutatorForbiddenError("this workflow has no saved definition to activate");
    case "row_version_conflict":
      return new MutatorForbiddenError("the workflow changed while this edit was in flight");
    case "readiness_blocked":
      return new MutatorForbiddenError(failure.blockers.map((p) => p.message).join(" "));
    case "stale_revision":
      return new MutatorForbiddenError("the workflow definition changed before activation");
    case "slug_taken":
      return new MutatorForbiddenError(`a workflow named '${failure.slug}' already exists`);
    case "not_found":
      return new MutatorForbiddenError("workflow not found");
    default: {
      const unhandled: never = failure;
      return unhandled;
    }
  }
}

function canonicalSource(rawKey: string, source: MemorySource): MemorySource {
  const canon = canonicalizeFactKey(rawKey);
  if (!canon.ok || !canon.wasAlias) return source;
  return { ...source, meta: { ...source.meta, originalKey: canon.originalKey } };
}

async function activeFactsForKey(tx: DbTx, userId: string, key: string): Promise<UserFact[]> {
  return tx
    .select()
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, userId),
        eq(userFacts.key, key),
        inArray(userFacts.status, ["proposed", "confirmed"]),
        lte(userFacts.validFrom, sql`now()`),
        or(isNull(userFacts.validUntil), gt(userFacts.validUntil, sql`now()`)),
      ),
    )
    .limit(50);
}

async function supersedeConflictingConfirmedFacts(
  tx: DbTx,
  userId: string,
  key: string,
  incomingValue: unknown,
  now: Date,
  excludeFactId?: string,
): Promise<UserFact[]> {
  if (!isSingleValuedKey(key)) return [];
  const incomingSig = valueSignature(incomingValue);
  const conflicts = (await activeFactsForKey(tx, userId, key)).filter(
    (row) =>
      row.id !== excludeFactId &&
      row.status === "confirmed" &&
      valueSignature(row.value) !== incomingSig,
  );
  if (conflicts.length === 0) return [];
  await tx
    .update(userFacts)
    .set({
      status: "superseded",
      validUntil: now,
      rowVersion: sql`${userFacts.rowVersion} + 1`,
    })
    .where(
      and(
        eq(userFacts.userId, userId),
        inArray(
          userFacts.id,
          conflicts.map((row) => row.id),
        ),
      ),
    );
  return conflicts;
}

/**
 * Server-side mutators run inside the push handler's outer transaction
 * (via a per-mutator savepoint). Atomicity guarantees:
 *   - the mutator's writes commit together with the LMID advance, OR
 *   - the savepoint rolls back and the LMID still advances so the
 *     client doesn't re-queue the failed mutation forever.
 *
 * Memory primitives (`@alfred/assistant/knowledge`) open their
 * own transactions via `db()`, which would escape this savepoint. The
 * fact mutators below re-implement the same logic inline against the
 * supplied `tx` so atomicity is preserved.
 */
export const serverMutators = {
  async noteCreate(tx: DbTx, args: NoteCreateArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .insert(notes)
      .values({
        id: args.id,
        userId: ctx.userId,
        text: args.text,
        createdAt: new Date(args.createdAt),
      })
      .onConflictDoNothing();
  },

  /**
   * Confirm a `proposed` row. No-op if the row is missing or already
   * past the proposed state — Replicache's at-least-once delivery means
   * confirm may arrive twice; the second is harmless. Mirrors
   * `confirmFact()`'s #330 single-valued invariant inside the push tx:
   * confirming a held conflict supersedes the prior active truth instead of
   * leaving two confirmed `employer`/`job_title`/etc. rows.
   */
  async factConfirm(tx: DbTx, args: FactConfirmArgs, ctx: ServerMutatorCtx): Promise<void> {
    const [candidate] = await tx
      .select()
      .from(userFacts)
      .where(
        and(
          eq(userFacts.id, args.factId),
          eq(userFacts.userId, ctx.userId),
          eq(userFacts.status, "proposed"),
        ),
      )
      .limit(1);
    if (!candidate) return;

    const key = canonicalFactKey(candidate.key);
    const source = canonicalSource(candidate.key, candidate.source as MemorySource);
    await lockFactKey(tx, ctx.userId, key);
    const now = new Date();
    const conflicts = await supersedeConflictingConfirmedFacts(
      tx,
      ctx.userId,
      key,
      candidate.value,
      now,
      candidate.id,
    );

    await tx
      .update(userFacts)
      .set({
        key,
        source,
        status: "confirmed",
        supersedesId: conflicts[0]?.id ?? candidate.supersedesId,
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(
        and(
          eq(userFacts.id, args.factId),
          eq(userFacts.userId, ctx.userId),
          eq(userFacts.status, "proposed"),
        ),
      );
  },

  /**
   * User-authored create: insert a `confirmed` user-sourced fact. Unlike
   * Alfred's extraction (which `proposeFact`s server-side and runs the
   * dedup/rejection guards), a user asserting a fact directly via the UI is
   * authoritative — confidence 1. Idempotent on id (client mints it before
   * push) so at-least-once redelivery is a harmless no-op. It still runs the
   * #330 canonical key + single-valued supersession invariant so direct user
   * writes cannot fork `company` from `employer` or leave two active truths.
   */
  async factCreate(tx: DbTx, args: FactCreateArgs, ctx: ServerMutatorCtx): Promise<void> {
    const key = canonicalFactKey(args.key);
    const source = canonicalSource(args.key, args.source ?? { kind: "user" });
    await lockFactKey(tx, ctx.userId, key);

    const sig = valueSignature(args.value);
    const active = await activeFactsForKey(tx, ctx.userId, key);
    if (active.some((row) => valueSignature(row.value) === sig)) return;

    const now = new Date();
    const conflicts = await supersedeConflictingConfirmedFacts(
      tx,
      ctx.userId,
      key,
      args.value,
      now,
    );

    await tx
      .insert(userFacts)
      .values({
        id: args.id,
        userId: ctx.userId,
        key,
        value: args.value,
        confidence: 1,
        status: "confirmed",
        source,
        validFrom: now,
        validUntil: null,
        supersedesId: conflicts[0]?.id ?? null,
      })
      .onConflictDoNothing();
  },

  /**
   * Reject a fact: mark the row + record the (key, value) signature so
   * the extraction sub-agent doesn't re-propose it (ADR-0019).
   */
  async factReject(tx: DbTx, args: FactRejectArgs, ctx: ServerMutatorCtx): Promise<void> {
    const [old] = await tx
      .select()
      .from(userFacts)
      .where(and(eq(userFacts.id, args.factId), eq(userFacts.userId, ctx.userId)))
      .limit(1);
    if (!old) return;

    await tx
      .update(userFacts)
      .set({
        status: "rejected",
        validUntil: new Date(),
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(eq(userFacts.id, args.factId));

    await tx
      .insert(rejectedInferences)
      .values({
        userId: ctx.userId,
        key: old.key,
        valueSignature: valueSignature(old.value),
        proposedFactId: old.id,
        reason: args.reason ? { note: args.reason } : null,
      })
      .onConflictDoNothing();
  },

  /**
   * User-edit: old row → `edited`, a new `confirmed` row replaces it
   * with `supersedes_id` linking back. Idempotent on `newFactId` —
   * the client mints it before pushing so a retry is a no-op.
   */
  async factEdit(tx: DbTx, args: FactEditArgs, ctx: ServerMutatorCtx): Promise<void> {
    const [old] = await tx
      .select()
      .from(userFacts)
      .where(and(eq(userFacts.id, args.factId), eq(userFacts.userId, ctx.userId)))
      .limit(1);
    if (!old) return;

    const key = canonicalFactKey(old.key);
    const source = canonicalSource(old.key, args.source ?? { kind: "user" });
    const now = new Date();
    await lockFactKey(tx, ctx.userId, key);
    const conflicts = await supersedeConflictingConfirmedFacts(
      tx,
      ctx.userId,
      key,
      args.newValue,
      now,
      old.id,
    );

    await tx
      .update(userFacts)
      .set({
        status: "edited",
        validUntil: now,
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(eq(userFacts.id, args.factId));

    await tx
      .insert(userFacts)
      .values({
        id: args.newFactId,
        userId: ctx.userId,
        key,
        value: args.newValue,
        confidence: 1,
        status: "confirmed",
        source,
        validFrom: now,
        validUntil: null,
        supersedesId: conflicts[0]?.id ?? old.id,
      })
      .onConflictDoNothing();
  },

  /**
   * Upsert a preference. Last-write-wins per `(user_id, key)`; bumps
   * `row_version` so the next pull patches the client.
   *
   * Routed through `settings.upsertPreference` against `tx` rather than the
   * `setPreference()` gateway (which opens its own `db()` handle) so the write
   * commits inside the push handler's outer transaction. Awaited bare — no
   * `RETURNING` — so the emitted SQL is identical to the former inline.
   */
  async prefSet(tx: DbTx, args: PrefSetArgs, ctx: ServerMutatorCtx): Promise<void> {
    await upsertPreference(tx, {
      userId: ctx.userId,
      key: args.key,
      value: args.value,
      source: args.source,
    });
  },

  /** Delete a preference. No-op if missing. */
  async prefDelete(tx: DbTx, args: PrefDeleteArgs, ctx: ServerMutatorCtx): Promise<void> {
    await deletePreferenceRow(tx, ctx.userId, args.key);
  },

  async policySetIntegrationMode(
    tx: DbTx,
    args: PolicySetIntegrationModeArgs,
    ctx: ServerMutatorCtx,
  ): Promise<void> {
    const insertedRules: IntegrationRules = {
      ...DEFAULT_INTEGRATION_RULES,
      [args.slug]: { mode: args.mode },
    };

    await tx
      .insert(userActionPolicies)
      .values({
        userId: ctx.userId,
        defaultMode: "gated",
        integrationRules: insertedRules,
        approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
      })
      .onConflictDoUpdate({
        target: userActionPolicies.userId,
        set: {
          // `::text` casts are load-bearing: the driver binds these as untyped
          // parameters and Postgres can't infer the type inside `jsonb_build_object`
          // (VARIADIC "any") or the `->` overload, so it raises "could not determine
          // data type of parameter". The casts pin each to text.
          integrationRules: sql`jsonb_set(
            ${userActionPolicies.integrationRules} ||
              jsonb_build_object(
                ${args.slug}::text,
                COALESCE(${userActionPolicies.integrationRules}->${args.slug}::text, '{}'::jsonb)
              ),
            ARRAY[${args.slug}::text, 'mode'],
            to_jsonb(${args.mode}::text),
            true
          )`,
          rowVersion: sql`${userActionPolicies.rowVersion} + 1`,
        },
      });
  },

  /**
   * Flip the user's global approval default. Inserts a baseline row (legacy
   * users predating the signup seed) or patches `default_mode` in place. The
   * push handler busts the dispatcher's policy cache after commit (see
   * `POLICY_BUST_MUTATORS`) so a gated→autonomy flip takes effect on the next
   * tool call without a restart.
   */
  async policySetDefaultMode(
    tx: DbTx,
    args: PolicySetDefaultModeArgs,
    ctx: ServerMutatorCtx,
  ): Promise<void> {
    await tx
      .insert(userActionPolicies)
      .values({
        userId: ctx.userId,
        defaultMode: args.mode,
        integrationRules: DEFAULT_INTEGRATION_RULES,
        approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
      })
      .onConflictDoUpdate({
        target: userActionPolicies.userId,
        set: {
          defaultMode: args.mode,
          rowVersion: sql`${userActionPolicies.rowVersion} + 1`,
        },
      });
  },

  /**
   * Patch a user-authored workflow (m13 Phase 8 event-trigger authoring).
   *
   * Every definition write goes through the revision service (#555) — this
   * mutator owns transport concerns only: find the row by slug, split the patch
   * into "what it does" and "whether it runs", and turn a typed service failure
   * into the ACL error `push.ts` already handles.
   *
   * An edit appends a revision and moves `current_revision_id`. On an
   * already-published workflow the running definition is untouched, so the
   * editor produces *unpublished changes* rather than a live rewrite.
   * Activation is refused here: publication must pass through the staged,
   * high-risk exact-contract approval owned by `system.activate_workflow`.
   */
  async workflowUpdate(tx: DbTx, args: WorkflowUpdateArgs, ctx: ServerMutatorCtx): Promise<void> {
    const [existing] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.userId, ctx.userId), eq(workflows.slug, args.slug)))
      .limit(1);
    // Unknown slug → drop silently (Replicache at-least-once; a deleted row
    // shouldn't wedge the client). Built-in rows are read-only.
    if (!existing) return;
    if (existing.isBuiltin) {
      throw new MutatorForbiddenError("cannot edit a built-in workflow");
    }
    if (args.status === "active") {
      throw new MutatorForbiddenError(
        "workflow activation requires the exact high-risk approval contract",
      );
    }

    const patch: WorkflowDefinitionPatch = {
      name: args.name,
      description: args.description,
      brief: args.brief,
      trigger: args.trigger,
      allowedIntegrations: args.allowedIntegrations,
    };
    const hasDefinitionPatch = Object.values(patch).some((value) => value !== undefined);
    if (hasDefinitionPatch) {
      const revised = await reviseWorkflowFromPatch({
        userId: ctx.userId,
        workflowId: existing.id,
        patch,
        expectedRowVersion: args.expectedRowVersion,
        tx,
      });
      if (!revised.ok) throw workflowMutatorError(revised.failure);
    }

    if (args.status === undefined) return;
    const applied = await setWorkflowStatus({
      userId: ctx.userId,
      workflowId: existing.id,
      status: args.status,
      ...(hasDefinitionPatch ? {} : { expectedRowVersion: args.expectedRowVersion }),
      tx,
    });
    if (!applied.ok) {
      throw workflowMutatorError(applied.failure);
    }
  },

  // ── Todos (ADR-0050) ──────────────────────────────────────────────────
  // User-authored creates + user-initiated lifecycle transitions. Alfred's
  // proposals enter server-side via the `system.suggest_todo` tool, not here.
  // Every transition is guarded on the source status so Replicache's
  // at-least-once redelivery is a harmless no-op the second time.

  /** Add a user-authored todo. Idempotent on id (client mints it before push). */
  async todoCreate(tx: DbTx, args: TodoCreateArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .insert(todos)
      .values({
        id: args.id,
        userId: ctx.userId,
        name: args.name,
        description: args.description ?? null,
        status: "open",
        createdBy: "user",
        createdAt: new Date(args.createdAt),
      })
      .onConflictDoNothing();
  },

  /** Check the box: `open → done`, stamp `completed_at`. */
  async todoComplete(tx: DbTx, args: TodoCompleteArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .update(todos)
      .set({
        status: "done",
        completedAt: new Date(),
        rowVersion: sql`${todos.rowVersion} + 1`,
      })
      .where(and(eq(todos.id, args.id), eq(todos.userId, ctx.userId), eq(todos.status, "open")));
  },

  /**
   * Mark a suggestion done directly: `suggested → done`, stamp `completed_at`.
   * Provenance (`created_by`, `sources`, `assist`) is left untouched, so the
   * completed row keeps the suggestion's context. Guarded on `suggested`.
   */
  async todoCompleteSuggestion(
    tx: DbTx,
    args: TodoCompleteSuggestionArgs,
    ctx: ServerMutatorCtx,
  ): Promise<void> {
    await tx
      .update(todos)
      .set({
        status: "done",
        completedAt: new Date(),
        rowVersion: sql`${todos.rowVersion} + 1`,
      })
      .where(
        and(eq(todos.id, args.id), eq(todos.userId, ctx.userId), eq(todos.status, "suggested")),
      );
  },

  /** Uncheck the box: `done → open`, clear `completed_at`. */
  async todoReopen(tx: DbTx, args: TodoReopenArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .update(todos)
      .set({
        status: "open",
        completedAt: null,
        rowVersion: sql`${todos.rowVersion} + 1`,
      })
      .where(and(eq(todos.id, args.id), eq(todos.userId, ctx.userId), eq(todos.status, "done")));
  },

  /** Accept a suggestion: `suggested → open`. `created_by` is preserved. */
  async todoPromote(tx: DbTx, args: TodoPromoteArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .update(todos)
      .set({ status: "open", rowVersion: sql`${todos.rowVersion} + 1` })
      .where(
        and(eq(todos.id, args.id), eq(todos.userId, ctx.userId), eq(todos.status, "suggested")),
      );
  },

  /**
   * Decline a suggestion or drop an open todo → terminal `dismissed`. The pull
   * fetcher excludes `dismissed`, so the next pull deletes the client row.
   */
  async todoDismiss(tx: DbTx, args: TodoDismissArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .update(todos)
      .set({ status: "dismissed", rowVersion: sql`${todos.rowVersion} + 1` })
      .where(
        and(
          eq(todos.id, args.id),
          eq(todos.userId, ctx.userId),
          inArray(todos.status, ["open", "suggested"]),
        ),
      );
  },

  /**
   * Personally clear a completed todo → terminal `cleared`. The pull fetcher
   * excludes `cleared` (like `dismissed`), so the next pull deletes the client
   * row. Guarded on `done` so it can't drop a live todo; reopening stays a
   * separate `done → open` transition.
   */
  async todoClear(tx: DbTx, args: TodoClearArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .update(todos)
      .set({ status: "cleared", rowVersion: sql`${todos.rowVersion} + 1` })
      .where(and(eq(todos.id, args.id), eq(todos.userId, ctx.userId), eq(todos.status, "done")));
  },

  /** Edit a todo's name and/or description. */
  async todoEdit(tx: DbTx, args: TodoEditArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .update(todos)
      .set({
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        rowVersion: sql`${todos.rowVersion} + 1`,
      })
      .where(and(eq(todos.id, args.id), eq(todos.userId, ctx.userId)));
  },

  // ── Chat (streaming-chat plan) ────────────────────────────────────────
  // Only the user side mutates via Replicache: opening a thread and appending
  // the user's message. The assistant reply is worker-written on completion.
  // Both are idempotent on id so at-least-once redelivery is a no-op.

  /** Open a new chat thread. Idempotent on id (client mints it before push). */
  async chatThreadCreate(
    tx: DbTx,
    args: ChatThreadCreateArgs,
    ctx: ServerMutatorCtx,
  ): Promise<void> {
    await tx
      .insert(chatThreads)
      .values({
        id: args.id,
        userId: ctx.userId,
        lastMessageAt: new Date(args.createdAt),
        createdAt: new Date(args.createdAt),
      })
      .onConflictDoNothing();
  },

  /** Append the user's message and float its thread to the top of the list. */
  async chatMessageCreate(
    tx: DbTx,
    args: ChatMessageCreateArgs,
    ctx: ServerMutatorCtx,
  ): Promise<void> {
    await tx
      .insert(chatMessages)
      .values({
        id: args.id,
        userId: ctx.userId,
        threadId: args.threadId,
        role: "user",
        content: args.content,
        status: "complete",
        createdAt: new Date(args.createdAt),
      })
      .onConflictDoNothing();
    // Bump lastMessageAt only on a thread this user owns.
    await tx
      .update(chatThreads)
      .set({
        lastMessageAt: new Date(args.createdAt),
        rowVersion: sql`${chatThreads.rowVersion} + 1`,
      })
      .where(and(eq(chatThreads.id, args.threadId), eq(chatThreads.userId, ctx.userId)));
  },

  /**
   * Optimistic-only attachment mutator (ADR-0065). The client uses this to render
   * a just-uploaded image immediately, but the server intentionally does not
   * persist from this Replicache mutation: accepting a client descriptor here
   * would mark an object `ready` without proving the bucket object exists or that
   * its bytes match the declared image type. The `/api/chat/threads/:id/turn`
   * endpoint is the canonical write path because it can verify the object before
   * inserting `chat_attachments`.
   */
  async chatAttachmentCreate(
    _tx: DbTx,
    _args: ChatAttachmentCreateArgs,
    _ctx: ServerMutatorCtx,
  ): Promise<void> {
    return;
  },

  /** Rename a thread. No-op on a thread this user doesn't own. */
  async chatThreadRename(
    tx: DbTx,
    args: ChatThreadRenameArgs,
    ctx: ServerMutatorCtx,
  ): Promise<void> {
    await tx
      .update(chatThreads)
      .set({ title: args.title, rowVersion: sql`${chatThreads.rowVersion} + 1` })
      .where(and(eq(chatThreads.id, args.id), eq(chatThreads.userId, ctx.userId)));
  },

  /** Pin / unpin a thread. No-op on a thread this user doesn't own. */
  async chatThreadSetPinned(
    tx: DbTx,
    args: ChatThreadSetPinnedArgs,
    ctx: ServerMutatorCtx,
  ): Promise<void> {
    await tx
      .update(chatThreads)
      .set({ pinned: args.pinned, rowVersion: sql`${chatThreads.rowVersion} + 1` })
      .where(and(eq(chatThreads.id, args.id), eq(chatThreads.userId, ctx.userId)));
  },

  /**
   * Hard-delete a thread. Its `chat_messages` cascade via the FK; the next
   * pull diff drops the thread + message rows from the client. No-op on a
   * thread this user doesn't own.
   */
  async chatThreadDelete(
    tx: DbTx,
    args: ChatThreadDeleteArgs,
    ctx: ServerMutatorCtx,
  ): Promise<void> {
    await tx
      .delete(chatThreads)
      .where(and(eq(chatThreads.id, args.id), eq(chatThreads.userId, ctx.userId)));
  },

  // ── Triage tags (rfc-triage-tags.md) ──────────────────────────────────
  // User override of a thread's classifier tag. Writes the DB truth inline
  // against the push `tx` (so it commits with the LMID advance); the Gmail
  // label is reconciled AFTER commit via `enqueueTriageRelabel` (push.ts).
  // No Gmail IO here — external IO cannot be transactional.

  /**
   * Override a thread's tag → `source='user'`. No-op if the thread has no
   * `email_triage` row yet (override before first classify); the eventual
   * classify writes `auto` and the user can override again.
   */
  async triageTagOverride(
    tx: DbTx,
    args: TriageTagOverrideArgs,
    ctx: ServerMutatorCtx,
  ): Promise<{ applied: boolean }> {
    const now = new Date();
    const rows = await tx
      .update(emailTriage)
      .set({
        category: args.category,
        source: "user",
        overriddenAt: now,
        appliedLabelId: null,
        rowVersion: sql`${emailTriage.rowVersion} + 1`,
        updatedAt: now,
      })
      .where(and(eq(emailTriage.userId, ctx.userId), eq(emailTriage.sourceThreadId, args.threadId)))
      .returning({ sourceThreadId: emailTriage.sourceThreadId });
    return { applied: rows.length > 0 };
  },
} satisfies Record<MutatorName, ServerMutator>;
