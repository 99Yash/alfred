import type { IntegrationSlug, LoadableIntegrationSlug, PolicyMode } from "@alfred/contracts";
import { resolveIntegrationMode } from "@alfred/contracts";
import { SYNC_MODEL, type SyncedActionPolicy } from "@alfred/sync";
import { useCallback } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";
import { useReplicacheSubscription } from "./use-replicache-subscription";

function scanActionPolicy(tx: ReadTransaction): Promise<SyncedActionPolicy[]> {
  return SYNC_MODEL.actionpolicy.scan(tx);
}

export interface ActionPolicyState {
  /** Null before the first pull or when no row exists. */
  policy: SyncedActionPolicy | null;
  /** The integration's rule, else the user default. */
  modeFor: (slug: IntegrationSlug) => PolicyMode | null;
  setIntegrationMode: (slug: LoadableIntegrationSlug, mode: PolicyMode) => Promise<void>;
  setDefaultMode: (mode: PolicyMode) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * The user's action policy: one row per user, so the scan yields at most one value.
 * `modeFor` uses `resolveIntegrationMode`, the same rule the server enforces.
 */
export function useActionPolicy(): ActionPolicyState {
  const { rep, loadError, retry } = useReplicacheStatus();
  const rows = useReplicacheSubscription(scanActionPolicy);
  const policy = rows?.[0] ?? null;

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
    loading: rows === null && !loadError,
    error: loadError,
    retry,
  };
}
