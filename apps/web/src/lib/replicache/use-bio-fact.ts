import { isNonEmptyString } from "@alfred/contracts";
import { SYNC_MODEL, type SyncedFact } from "@alfred/sync";
import { useCallback } from "react";
import type { ReadTransaction } from "replicache";
import { authClient } from "~/lib/auth/auth-client";
import { useReplicache } from "./context";
import { useReplicacheSubscription } from "./use-replicache-subscription";

/** The fact key cold-start writes the bio under. */
const BIO_KEY = "bio_summary";

export interface BioFactState {
  /** Empty string when unset. */
  value: string;
  loading: boolean;
  error: string | null;
  retry: () => void;
  /** Supersede the active fact, or create one. Throws while the sync client loads. */
  saveBio: (text: string) => Promise<void>;
}

function scanFacts(tx: ReadTransaction): Promise<SyncedFact[]> {
  return SYNC_MODEL.fact.scan(tx);
}

function activeBio(facts: SyncedFact[]): SyncedFact | null {
  const active = facts.filter((f) => f.key === BIO_KEY && f.validUntil === null);

  // Mid-pull, both a confirmed and a proposed row can be active.
  return active.find((f) => f.status === "confirmed") ?? active[0] ?? null;
}

function toText(value: unknown): string {
  return isNonEmptyString(value) ? value : "";
}

/** The active `bio_summary` fact, for the settings Background card. */
export function useBioFact(): BioFactState {
  const rep = useReplicache();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const { data, loading, error, retry } = useReplicacheSubscription(scanFacts, activeBio);
  const bio = data ?? null;

  const saveBio = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();

      // Throw so the caller toasts instead of reporting a save that did not happen.
      if (!rep || !userId) {
        throw new Error("Sync client not ready. Bio not saved.");
      }

      if (bio) {
        await rep.mutate.factEdit({
          factId: bio.id,
          newFactId: crypto.randomUUID(),
          newValue: trimmed,
        });
      } else {
        await rep.mutate.factCreate({
          id: crypto.randomUUID(),
          userId,
          key: BIO_KEY,
          value: trimmed,
        });
      }
    },
    [rep, userId, bio],
  );

  return {
    value: toText(bio?.value),
    loading,
    error,
    retry,
    saveBio,
  };
}
