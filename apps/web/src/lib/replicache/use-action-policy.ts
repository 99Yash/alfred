import type { IntegrationSlug, LoadableIntegrationSlug, PolicyMode } from "@alfred/contracts";
import { resolveIntegrationMode } from "@alfred/contracts";
import { IDB_KEY, syncedActionPolicySchema, type SyncedActionPolicy } from "@alfred/sync";
import { useCallback, useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";

export interface ActionPolicyState {
  /** The synced policy row, or null before first pull or when no row exists. */
  policy: SyncedActionPolicy | null;
  /** Effective mode for an integration: per-integration rule ?? user default. */
  modeFor: (slug: IntegrationSlug) => PolicyMode | null;
  /** Optimistically flip one integration's mode; server confirms on pull. */
  setIntegrationMode: (slug: LoadableIntegrationSlug, mode: PolicyMode) => Promise<void>;
  /** Optimistically flip the global default mode; server confirms on pull. */
  setDefaultMode: (mode: PolicyMode) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Live view of the user's per-integration action policy (m13 Phase 8c).
 *
 * The row is one synced entity keyed by `userId`, so the scan yields at most
 * one value. `modeFor` derives each integration's effective mode client-side
 * via the shared `resolveIntegrationMode` helper — the same projection the
 * server dispatcher uses, so the radio shows exactly what will be enforced.
 */
export function useActionPolicy(): ActionPolicyState {
  const { rep, loadError, retry } = useReplicacheStatus();
  const [policy, setPolicy] = useState<SyncedActionPolicy | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!rep) {
      setPolicy(null);
      setLoaded(false);
      return;
    }
    const prefix = IDB_KEY.ACTION_POLICY({});
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (values) => {
        const first = values[0];
        const result = first ? syncedActionPolicySchema.safeParse(first) : null;
        setPolicy(result?.success ? result.data : null);
        setLoaded(true);
      },
    );
  }, [rep]);

  const modeFor = useCallback(
    (slug: IntegrationSlug): PolicyMode | null =>
      policy ? resolveIntegrationMode(policy.integrationRules, slug, policy.defaultMode) : null,
    [policy],
  );

  const setIntegrationMode = useCallback(
    async (slug: LoadableIntegrationSlug, mode: PolicyMode): Promise<void> => {
      if (!rep) return;
      await rep.mutate.policySetIntegrationMode({ slug, mode });
    },
    [rep],
  );

  const setDefaultMode = useCallback(
    async (mode: PolicyMode): Promise<void> => {
      if (!rep) return;
      await rep.mutate.policySetDefaultMode({ mode });
    },
    [rep],
  );

  return {
    policy,
    modeFor,
    setIntegrationMode,
    setDefaultMode,
    loading: !loaded && !loadError,
    error: loadError,
    retry,
  };
}
