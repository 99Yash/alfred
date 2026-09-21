import {
  enumGuard,
  humanizeSlug,
  isToolRiskTier,
  MCP_TOOL_POLICY_NOTE_MAX,
  mcpEffectClassValues,
  mcpRetryContractValues,
  TOOL_RISK_TIERS,
  toMessage,
  type ExternalToolRef,
  type McpEffectClass,
  type McpRetryContract,
  type ToolRiskTier,
} from "@alfred/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppButton, AppSelect, AppTextarea, type AppSelectOption } from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { MCP_TOOL_POLICY_QUERY_KEY, type McpToolPolicyState } from "./helpers";

/**
 * The reviewed fields the owner edits. `note` is normalized to `null` when the
 * field is blank, matching the contract's nullable note.
 */
export interface McpToolPolicyDraft {
  readonly riskTier: ToolRiskTier;
  readonly effectClass: McpEffectClass;
  readonly retryContract: McpRetryContract;
  readonly note: string | null;
}

/**
 * The conservative defaults a first review opens with: an unknown effect
 * handled as effectful, and no retry — the persisted column defaults.
 *
 * `riskTier` is deliberately NOT defaulted. The floor a freshly connected
 * tool carries lives on the gate (`MCP_CALL_RISK_FLOOR`); a browser copy of it
 * would silently turn a first save into a raise the day the floor moves, so the
 * owner must choose the tier explicitly.
 */
const MCP_TOOL_POLICY_CONSERVATIVE_DEFAULTS = {
  effectClass: "unknown",
  retryContract: "never",
  note: null,
} satisfies Omit<McpToolPolicyDraft, "riskTier">;

const isEffectClass = enumGuard(mcpEffectClassValues);

const isRetryContract = enumGuard(mcpRetryContractValues);

const RISK_TIER_OPTIONS: ReadonlyArray<AppSelectOption> = TOOL_RISK_TIERS.map((tier) => ({
  value: tier,
  label: humanizeSlug(tier),
}));

const EFFECT_CLASS_OPTIONS: ReadonlyArray<AppSelectOption> = mcpEffectClassValues.map((value) => ({
  value,
  label: humanizeSlug(value),
}));

const RETRY_CONTRACT_OPTIONS: ReadonlyArray<AppSelectOption> = mcpRetryContractValues.map(
  (value) => ({ value, label: humanizeSlug(value) }),
);

export interface McpToolPolicyController {
  readonly state: McpToolPolicyState | undefined;
  readonly loading: boolean;
  readonly readError: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onSave: (draft: McpToolPolicyDraft) => void;
  readonly onClear: () => void;
}

/**
 * One exact tool's review state plus its two writes, flattened for the view.
 *
 * The read is keyed by the full tool identity (connection, remote name, catalog
 * revision) because a review binds to a descriptor, not to a connection. Both
 * mutations invalidate the whole policy family on settle, so a failed write and
 * a succeeded one both leave the read honest; neither is a local cache patch,
 * because the server owns `policyRevision` and the drifted classification.
 */
export function useMcpToolPolicy(
  connectionId: string,
  ref: ExternalToolRef,
): McpToolPolicyController {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const route = client.api.integrations.mcp.connections({ id: connectionId }).tools;

  const queryKey = [
    ...MCP_TOOL_POLICY_QUERY_KEY,
    connectionId,
    ref.remoteName,
    ref.catalogRevision,
  ] as const;

  const stateQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await route.policy.get({
        query: { remoteName: ref.remoteName, catalogRevision: ref.catalogRevision },
      });

      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Load MCP tool review"),
        );
      }

      if (!response.data) throw new Error("Could not load the MCP tool review");

      return response.data;
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: MCP_TOOL_POLICY_QUERY_KEY });

  const review = useMutation({
    mutationFn: async (draft: McpToolPolicyDraft) => {
      const response = await route.policy.put({
        ref,
        riskTier: draft.riskTier,
        effectClass: draft.effectClass,
        retryContract: draft.retryContract,
        note: draft.note,
      });

      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Review MCP tool"),
        );
      }

      return response.data;
    },
    onMutate: () => setError(null),
    onSettled: invalidate,
    onError: (cause) => setError(toMessage(cause)),
  });

  const clear = useMutation({
    mutationFn: async () => {
      const response = await route.policy.delete({ ref });

      if (response.error) {
        throw new Error(
          responseErrorMessage(
            response.error.value,
            response.error.status,
            "Clear MCP tool review",
          ),
        );
      }

      return response.data;
    },
    onMutate: () => setError(null),
    onSettled: invalidate,
    onError: (cause) => setError(toMessage(cause)),
  });

  return {
    state: stateQuery.data,
    loading: stateQuery.isPending,
    readError: stateQuery.isError,
    pending: review.isPending || clear.isPending,
    error,
    onRetry: () => {
      void stateQuery.refetch();
    },
    onSave: (draft) => review.mutate(draft),
    onClear: () => clear.mutate(),
  };
}

function draftFromPolicy(state: Extract<McpToolPolicyState, { status: "reviewed" | "drifted" }>) {
  const policy = state.status === "reviewed" ? state.policy : state.previous;

  return {
    riskTier: policy.riskTier,
    effectClass: policy.effectClass,
    retryContract: policy.retryContract,
    note: policy.note,
  };
}

interface McpToolPolicyFormProps {
  /** Starting values. `riskTier` is absent for a first review, which must be an explicit choice. */
  initial: Partial<McpToolPolicyDraft>;
  pending: boolean;
  onSave: (draft: McpToolPolicyDraft) => void;
  /** Present only when there is a review to clear. */
  onClear?: (() => void) | undefined;
}

/**
 * The review form. Local state only, and the container keys it by the identity
 * of both the tool and the state it renders, so a refetch after a save, or a
 * switch to another tool that shares a status, remounts it with the server's
 * values rather than mirroring props into state with an effect.
 */
function McpToolPolicyForm({ initial, pending, onSave, onClear }: McpToolPolicyFormProps) {
  const [riskTier, setRiskTier] = useState<ToolRiskTier | undefined>(initial.riskTier);
  const [effectClass, setEffectClass] = useState(initial.effectClass ?? "unknown");
  const [retryContract, setRetryContract] = useState(initial.retryContract ?? "never");
  const [note, setNote] = useState(initial.note ?? "");

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();

        // The tier is the approval decision; a form without one cannot save.
        if (riskTier === undefined) return;
        const trimmed = note.trim();

        onSave({
          riskTier,
          effectClass,
          retryContract,
          note: trimmed.length > 0 ? trimmed : null,
        });
      }}
    >
      <div className="grid grid-cols-3 gap-2">
        <AppSelect
          label="Approval tier"
          placeholder="Select a tier"
          value={riskTier}
          options={RISK_TIER_OPTIONS}
          disabled={pending}
          onChange={(value) => {
            if (value !== undefined && isToolRiskTier(value)) setRiskTier(value);
          }}
        />
        <AppSelect
          label="Effect"
          value={effectClass}
          options={EFFECT_CLASS_OPTIONS}
          disabled={pending}
          onChange={(value) => {
            if (value !== undefined && isEffectClass(value)) setEffectClass(value);
          }}
        />
        <AppSelect
          label="Retry"
          value={retryContract}
          options={RETRY_CONTRACT_OPTIONS}
          disabled={pending}
          onChange={(value) => {
            if (value !== undefined && isRetryContract(value)) setRetryContract(value);
          }}
        />
      </div>
      <AppTextarea
        aria-label="Review note"
        maxLength={MCP_TOOL_POLICY_NOTE_MAX}
        placeholder="Why this tier?"
        value={note}
        disabled={pending}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex items-center gap-1">
        <AppButton
          type="submit"
          size="sm"
          variant="primary"
          disabled={pending || riskTier === undefined}
        >
          Save review
        </AppButton>
        {onClear ? (
          <AppButton type="button" size="sm" variant="ghost" disabled={pending} onClick={onClear}>
            Clear review
          </AppButton>
        ) : null}
      </div>
    </form>
  );
}

export interface McpToolPolicyReviewViewProps extends McpToolPolicyController {}

/**
 * The review surface's presentation, without hooks.
 *
 * Every arm of the wire union is reachable from `renderToStaticMarkup`
 * (apps/web has no jsdom): loading, read failure, and each of `reviewed`,
 * `unreviewed`, `drifted`, `catalog_stale`, and `not_found`. `catalog_stale`
 * and `not_found` are states, not errors: the read succeeded and is telling the
 * owner the tool they selected is no longer the one the server has.
 */
export function McpToolPolicyReviewView({
  state,
  loading,
  readError,
  pending,
  error,
  onRetry,
  onSave,
  onClear,
}: McpToolPolicyReviewViewProps) {
  return (
    <div className="space-y-2 rounded-lg bg-app-bg-2 p-2">
      <p className="text-xs font-medium text-app-fg-4">Approval policy</p>

      {loading ? (
        <p className="text-xs text-app-fg-3" role="status">
          Loading review…
        </p>
      ) : readError ? (
        <div className="flex items-center gap-2" role="alert">
          <p className="text-xs text-red-600">Could not load the MCP tool review.</p>
          <AppButton size="sm" variant="white" onClick={onRetry}>
            Retry
          </AppButton>
        </div>
      ) : state === undefined ? null : state.status === "catalog_stale" ? (
        <p className="text-xs text-app-fg-3">
          The catalog changed. Refresh and inspect this tool again before reviewing it.
        </p>
      ) : state.status === "not_found" ? (
        <p className="text-xs text-app-fg-3">This tool is not in the current catalog.</p>
      ) : state.status === "drifted" ? (
        <div className="space-y-2">
          <p className="text-xs text-app-amber-4" role="status">
            The descriptor changed, so the earlier review no longer lowers this tool's tier. Review
            the current descriptor to apply a new one.
          </p>
          <McpToolPolicyForm
            key={`drifted:${state.previous.policyRevision}`}
            initial={draftFromPolicy(state)}
            pending={pending}
            onSave={onSave}
          />
        </div>
      ) : state.status === "reviewed" ? (
        <div className="space-y-2">
          <p className="text-xs text-app-fg-3" role="status">
            Reviewed (revision {state.policy.policyRevision}).
          </p>
          <McpToolPolicyForm
            key={`reviewed:${state.policy.policyRevision}`}
            initial={draftFromPolicy(state)}
            pending={pending}
            onSave={onSave}
            onClear={onClear}
          />
        </div>
      ) : (
        <McpToolPolicyForm
          key="unreviewed"
          initial={MCP_TOOL_POLICY_CONSERVATIVE_DEFAULTS}
          pending={pending}
          onSave={onSave}
        />
      )}

      {error ? (
        <p className="text-xs text-app-red-4" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The container the catalog panel mounts beneath the inspected descriptor. It
 * owns the read and the two mutations and hands them to the hook-free view.
 */
export function McpToolPolicyReview({
  connectionId,
  toolRef,
}: {
  connectionId: string;
  toolRef: ExternalToolRef;
}) {
  const controller = useMcpToolPolicy(connectionId, toolRef);

  return <McpToolPolicyReviewView {...controller} />;
}
