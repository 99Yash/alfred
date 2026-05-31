import type { IntegrationRules } from "@alfred/contracts";
import {
  notes,
  rejectedInferences,
  userActionPolicies,
  userFacts,
  userPreferences,
} from "@alfred/db/schemas";
import type {
  FactConfirmArgs,
  FactEditArgs,
  FactRejectArgs,
  NoteCreateArgs,
  PolicySetIntegrationModeArgs,
  PrefDeleteArgs,
  PrefSetArgs,
} from "@alfred/sync";
import { and, eq, sql } from "drizzle-orm";
import { DEFAULT_APPROVAL_NOTIFY_DELAY_MS } from "../action-policies";
import { valueSignature } from "../memory/signature";

/**
 * Baseline rules for a row that doesn't exist yet (legacy user predating the
 * signup seed). Must keep `system: autonomy` or system tools would start
 * gating — mirrors `ensureDefaultActionPolicyForUser` / `resolve.ts`.
 */
const DEFAULT_INTEGRATION_RULES: IntegrationRules = { system: { mode: "autonomy" } };

export interface ServerMutatorCtx {
  userId: string;
}

// Typed loosely so it accepts either the pool or a Drizzle tx handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbTx = any;

/**
 * Server-side mutators run inside the push handler's outer transaction
 * (via a per-mutator savepoint). Atomicity guarantees:
 *   - the mutator's writes commit together with the LMID advance, OR
 *   - the savepoint rolls back and the LMID still advances so the
 *     client doesn't re-queue the failed mutation forever.
 *
 * Memory primitives (`packages/api/src/modules/memory/*`) open their
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
   * confirm may arrive twice; the second is harmless.
   */
  async factConfirm(tx: DbTx, args: FactConfirmArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .update(userFacts)
      .set({ status: "confirmed", rowVersion: sql`${userFacts.rowVersion} + 1` })
      .where(
        and(
          eq(userFacts.id, args.factId),
          eq(userFacts.userId, ctx.userId),
          eq(userFacts.status, "proposed"),
        ),
      );
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

    const now = new Date();
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
        key: old.key,
        value: args.newValue,
        confidence: 1,
        status: "confirmed",
        source: args.source ?? { kind: "user" },
        validFrom: now,
        validUntil: null,
        supersedesId: old.id,
      })
      .onConflictDoNothing();
  },

  /**
   * Upsert a preference. Last-write-wins per `(user_id, key)`; bumps
   * `row_version` so the next pull patches the client.
   *
   * Inlined against `tx` rather than calling `setPreference()` so the
   * write commits inside the push handler's outer transaction.
   */
  async prefSet(tx: DbTx, args: PrefSetArgs, ctx: ServerMutatorCtx): Promise<void> {
    const source = args.source ?? { kind: "user" };
    await tx
      .insert(userPreferences)
      .values({ userId: ctx.userId, key: args.key, value: args.value, source })
      .onConflictDoUpdate({
        target: [userPreferences.userId, userPreferences.key],
        set: {
          value: args.value,
          source,
          rowVersion: sql`${userPreferences.rowVersion} + 1`,
        },
      });
  },

  /** Delete a preference. No-op if missing. */
  async prefDelete(tx: DbTx, args: PrefDeleteArgs, ctx: ServerMutatorCtx): Promise<void> {
    await tx
      .delete(userPreferences)
      .where(and(eq(userPreferences.userId, ctx.userId), eq(userPreferences.key, args.key)));
  },

  /**
   * Set one integration's policy mode (m13 Phase 8c). Read-merge-write so a
   * single integration's `mode` changes without trampling other integrations'
   * rules or per-tool overrides. Bumps `row_version` so the next pull patches
   * the synced singleton; the dispatcher cache bust (`publishPolicyBust`)
   * fires from the push handler *after* commit — see push.ts.
   *
   * Upsert handles the legacy no-row case by inserting a row seeded with the
   * m13 defaults (incl. `system: autonomy`) plus the chosen integration, so a
   * first-ever edit can't strip the system autonomy seed.
   */
  async policySetIntegrationMode(
    tx: DbTx,
    args: PolicySetIntegrationModeArgs,
    ctx: ServerMutatorCtx,
  ): Promise<void> {
    const [row] = await tx
      .select({ integrationRules: userActionPolicies.integrationRules })
      .from(userActionPolicies)
      .where(eq(userActionPolicies.userId, ctx.userId))
      .limit(1);

    const currentRules: IntegrationRules = row?.integrationRules ?? DEFAULT_INTEGRATION_RULES;
    const nextRules: IntegrationRules = {
      ...currentRules,
      [args.slug]: { ...currentRules[args.slug], mode: args.mode },
    };

    await tx
      .insert(userActionPolicies)
      .values({
        userId: ctx.userId,
        defaultMode: "gated",
        integrationRules: nextRules,
        approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
      })
      .onConflictDoUpdate({
        target: userActionPolicies.userId,
        set: {
          integrationRules: nextRules,
          rowVersion: sql`${userActionPolicies.rowVersion} + 1`,
        },
      });
  },
} as const;

export type ServerMutators = typeof serverMutators;
export type ServerMutatorName = keyof ServerMutators;
