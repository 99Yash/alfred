import { type FactValue, IDB_KEY, type SyncedFact, syncedFactSchema } from "@alfred/sync";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReadTransaction } from "replicache";
import { authClient } from "~/lib/auth-client";
import { useReplicacheStatus } from "./context";

/** The canonical fact key cold-start writes the user's bio paragraph under. */
const BIO_KEY = "bio_summary";

export interface BioFactState {
  /** Current bio text (empty string when unset). */
  value: string;
  /** True until the first Replicache subscription fires. */
  loading: boolean;
  error: string | null;
  retry: () => void;
  /**
   * Persist a new bio. Edits the active fact in place (supersede chain) when
   * one exists, otherwise creates a user-authored fact. No-op while the sync
   * client is still initializing.
   */
  saveBio: (text: string) => Promise<void>;
}

/** The fact's `value` is `unknown`; bio is always a paragraph string. */
function toText(value: FactValue | undefined): string {
  return typeof value === "string" ? value : "";
}

/**
 * Live view of the user's `bio_summary` fact for the settings Background card.
 * Both `proposed` and `confirmed` facts sync, and a fact's supersede chain
 * keeps exactly one row active (`validUntil === null`) per key, so we surface
 * that single active row.
 */
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
    const prefix = IDB_KEY.FACT({});
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (values) => {
        const parsed: SyncedFact[] = [];
        for (const value of values) {
          const result = syncedFactSchema.safeParse(value);
          if (result.success) parsed.push(result.data);
        }
        setRows(parsed);
      },
    );
  }, [rep]);

  const bio = useMemo(() => {
    const active = (rows ?? []).filter((f) => f.key === BIO_KEY && f.validUntil === null);
    // Prefer a confirmed row over a still-proposed one if both linger mid-pull.
    return active.find((f) => f.status === "confirmed") ?? active[0] ?? null;
  }, [rows]);

  const saveBio = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!rep || !userId) return;
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
    value: toText(bio?.value as FactValue | undefined),
    loading: rows === null && !loadError,
    error: loadError,
    retry,
    saveBio,
  };
}
