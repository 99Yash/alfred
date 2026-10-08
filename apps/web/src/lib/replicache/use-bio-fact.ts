import { isNonEmptyString } from "@alfred/contracts";
import { type FactValue, SYNC_MODEL, type SyncedFact } from "@alfred/sync";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReadTransaction } from "replicache";
import { authClient } from "~/lib/auth/auth-client";
import { useReplicacheStatus } from "./context";

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

function toText(value: FactValue | undefined): string {
  return isNonEmptyString(value) ? value : "";
}

/** The active `bio_summary` fact, for the settings Background card. */
export function useBioFact(): BioFactState {
  const { rep, loadError, retry } = useReplicacheStatus();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const [rows, setRows] = useState<SyncedFact[] | null>(null);

  useEffect(() => {
    if (!rep) {
      setRows(null);

      return;
    }

    return rep.subscribe((tx: ReadTransaction) => SYNC_MODEL.fact.scan(tx), setRows);
  }, [rep]);

  const bio = useMemo(() => {
    const active = (rows ?? []).filter((f) => f.key === BIO_KEY && f.validUntil === null);

    // Mid-pull, both a confirmed and a proposed row can be active.
    return active.find((f) => f.status === "confirmed") ?? active[0] ?? null;
  }, [rows]);

  const saveBio = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();

      // Throw so the caller toasts instead of reporting a save that did not happen.
      if (!rep || !userId) {
        throw new Error("Sync client not ready — bio not saved.");
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
    [rep, session?.user?.id, bio],
  );

  return {
    // SAFETY: the mutators wrote a `FactValue`; `toText` accepts anything.
    value: toText(bio?.value as FactValue | undefined),
    loading: rows === null && !loadError,
    error: loadError,
    retry,
    saveBio,
  };
}
