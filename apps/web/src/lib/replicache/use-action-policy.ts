import type {
  IntegrationSlug,
  LoadableIntegrationSlug,
  PolicyMode,
  ToolName,
} from "@alfred/contracts";
import { resolveIntegrationMode, resolveToolMode } from "@alfred/contracts";
import { SYNC_MODEL, type SyncedActionPolicy } from "@alfred/sync";
import { useCallback } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicache } from "./context";
import { useReplicacheSubscription } from "./use-replicache-subscription";

function scanActionPolicy(tx: ReadTransaction): Promise<SyncedActionPolicy[]> {
  return SYNC_MODEL.actionpolicy.scan(tx);
}

export interface ActionPolicyState {
  /** Null before the first pull or when no row exists. */
  policy: SyncedActionPolicy | null;
  /** The integration's rule, else the user default. */
  modeFor: (slug: IntegrationSlug) => PolicyMode | null;
  /** The tool's override, else {@link modeFor}. */
  toolModeFor: (toolName: ToolName) => PolicyMode | null;
  setIntegrationMode: (slug: LoadableIntegrationSlug, mode: PolicyMode) => Promise<void>;
  /** `null` clears the override. */
  setToolMode: (toolName: ToolName, mode: PolicyMode | null) => Promise<void>;
  setDefaultMode: (mode: PolicyMode) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * The user's action policy: one row per user, so the scan yields at most one value.
 * `modeFor` and `toolModeFor` use the same rules the server enforces.
 */
export function useActionPolicy(): ActionPolicyState {
  const rep = useReplicache();
  const { data, loading, error, retry } = useReplicacheSubscription(scanActionPolicy);
  const policy = data?.[0] ?? null;

  const modeFor = useCallback(
    (slug: IntegrationSlug): PolicyMode | null =>
      policy ? resolveIntegrationMode(policy.integrationRules, slug, policy.defaultMode) : null,
    [policy],
  );

  const toolModeFor = useCallback(
    (toolName: ToolName): PolicyMode | null =>
      policy ? resolveToolMode(policy.integrationRules, toolName, policy.defaultMode) : null,
    [policy],
  );

  const setToolMode = useCallback(
    async (toolName: ToolName, mode: PolicyMode | null): Promise<void> => {
      if (!rep) return;
      await rep.mutate.policySetToolMode({ toolName, mode });
    },
    [rep],
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
    toolModeFor,
    setIntegrationMode,
    setToolMode,
    setDefaultMode,
    loading,
    error,
    retry,
  };
}
