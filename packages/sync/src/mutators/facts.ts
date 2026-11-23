import { memoryPageEdit } from "@alfred/contracts";
import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { SYNC_MODEL } from "../sync-model";
import { factValueSchema } from "../schemas";
import type { SyncedFact } from "../schemas";

// Fact mutators (ADR-0019). A missing local row is a no-op; the next pull fixes it.

export const factConfirmArgsSchema = z.object({
  factId: z.string().min(1).max(100),
  /**
   * The `rowVersion` of the row that the user saw when they confirmed. The server confirms only
   * that version, so a confirm never lands on a claim that changed after the user read it.
   */
  seenRowVersion: z.number().int().min(0),
});

export type FactConfirmArgs = z.infer<typeof factConfirmArgsSchema>;

export const factRejectArgsSchema = z.object({
  factId: z.string().min(1).max(100),
  reason: z.string().max(2_000).optional(),
});

export type FactRejectArgs = z.infer<typeof factRejectArgsSchema>;

export const factCreateArgsSchema = z.object({
  /** Client-minted, so the optimistic row and the server row share one key. */
  id: z.string().min(1).max(100),
  /** Optimistic row only. The server uses the session user. */
  userId: z.string().min(1).max(100),
  /** Snake case, e.g. `bio_summary`. */
  key: z.string().min(1).max(100),
  value: factValueSchema,
});

export type FactCreateArgs = z.infer<typeof factCreateArgsSchema>;

export const factEditArgsSchema = z.object({
  factId: z.string().min(1).max(100),
  /** Client-minted id of the replacement row. The server uses it too. */
  newFactId: z.string().min(1).max(100),
  newValue: factValueSchema,
});

export type FactEditArgs = z.infer<typeof factEditArgsSchema>;

async function readFact(tx: WriteTransaction, factId: string): Promise<SyncedFact | null> {
  return SYNC_MODEL.fact.get(tx, { id: factId });
}

async function writeFact(tx: WriteTransaction, fact: SyncedFact): Promise<void> {
  await SYNC_MODEL.fact.put(tx, fact);
}

/** A claim the user states directly, so it is `confirmed` with confidence 1. Idempotent on id. */
export async function factCreateClient(tx: WriteTransaction, args: FactCreateArgs): Promise<void> {
  const now = new Date().toISOString();

  const fact: SyncedFact = {
    id: args.id,
    userId: args.userId,
    key: args.key,
    value: args.value,
    confidence: 1,
    status: "confirmed",
    author: "user",
    evidence: [memoryPageEdit("create", now)],
    validFrom: null,
    validUntil: null,
    supersedesId: null,
    rowVersion: 0,
    createdAt: now,
    updatedAt: now,
  };

  await writeFact(tx, fact);
}

export async function factConfirmClient(
  tx: WriteTransaction,
  args: FactConfirmArgs,
): Promise<void> {
  const fact = await readFact(tx, args.factId);

  if (!fact) return;

  if (fact.status !== "proposed" || fact.rowVersion !== args.seenRowVersion) return;
  await writeFact(tx, {
    ...fact,
    status: "confirmed",
    evidence: [...fact.evidence, memoryPageEdit("confirm", new Date().toISOString())],
    rowVersion: fact.rowVersion + 1,
  });
}

/** Delete locally: `rejected` rows do not sync. */
export async function factRejectClient(tx: WriteTransaction, args: FactRejectArgs): Promise<void> {
  await SYNC_MODEL.fact.del(tx, { id: args.factId });
}

/** Replace the old row with a `confirmed` row that supersedes it, as `editFact` does. */
export async function factEditClient(tx: WriteTransaction, args: FactEditArgs): Promise<void> {
  const old = await readFact(tx, args.factId);

  if (!old) return;
  await SYNC_MODEL.fact.del(tx, { id: args.factId });

  const now = new Date().toISOString();

  const replacement: SyncedFact = {
    id: args.newFactId,
    userId: old.userId,
    key: old.key,
    value: args.newValue,
    confidence: 1,
    status: "confirmed",
    author: "user",
    evidence: [memoryPageEdit("edit", now)],
    validFrom: null,
    validUntil: null,
    supersedesId: old.id,
    rowVersion: 0,
    createdAt: now,
    updatedAt: now,
  };

  await writeFact(tx, replacement);
}
