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

/** `note` is `null` when blank, as the contract expects. */
interface McpToolPolicyDraft {
  readonly riskTier: ToolRiskTier;
  readonly effectClass: McpEffectClass;
  readonly retryContract: McpRetryContract;
  readonly note: string | null;
}

/**
 * First-review defaults, matching the column defaults. `riskTier` has no default:
 * the floor lives on the server (`MCP_CALL_RISK_FLOOR`), and a browser copy would drift.
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
 * One tool's review state and its two writes. Keyed by connection, remote name,
 * and catalog revision, since a review binds to a descriptor.
 * Both writes invalidate on settle; the server owns `policyRevision`.
 */
function useMcpToolPolicy(connectionId: string, ref: ExternalToolRef): McpToolPolicyController {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const route = client.api.integrations.mcp.connections({ id: connectionId }).tools;
  const target = { remoteName: ref.remoteName, catalogRevision: ref.catalogRevision };

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
        query: target,
      });

      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Load MCP tool review"),
        );
      }

      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Eden treaty `data` is the server's JSON typed by its route, not parsed here; an empty body or a skewed deploy can leave it null.
      if (!response.data) throw new Error("Could not load the MCP tool review");

      return response.data;
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: MCP_TOOL_POLICY_QUERY_KEY });

  const review = useMutation({
    mutationFn: async (draft: McpToolPolicyDraft) => {
      const response = await route.policy.put({
        ...target,
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
      const response = await route.policy.delete(target);

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
  /** `riskTier` is absent on a first review; the owner must pick it. */
  initial: Partial<McpToolPolicyDraft>;
  pending: boolean;
  onSave: (draft: McpToolPolicyDraft) => void;
  onClear?: (() => void) | undefined;
}

/** Local state only. The container keys it by tool and state, so new server values remount it. */
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
          size="lg"
          variant="primary"
          disabled={pending || riskTier === undefined}
        >
          Save review
        </AppButton>
        {onClear ? (
          <AppButton type="button" size="lg" variant="ghost" disabled={pending} onClick={onClear}>
            Clear review
          </AppButton>
        ) : null}
      </div>
    </form>
  );
}

interface McpToolPolicyReviewViewProps extends McpToolPolicyController {}

/**
 * The review view without hooks, so `renderToStaticMarkup` reaches every arm (no jsdom).
 * `catalog_stale` and `not_found` are states, not errors.
 */
function McpToolPolicyReviewView({
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
    <div className="space-y-2 border-t border-app-bg-3 pt-4">
      <p className="text-xs font-medium text-app-fg-4">Approval policy</p>

      {loading ? (
        <p className="text-xs text-app-fg-3" role="status">
          Loading review…
        </p>
      ) : readError ? (
        <div className="flex items-center gap-2" role="alert">
          <p className="text-xs text-app-red-4">Could not load the MCP tool review.</p>
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

/** Owns the read and the two writes; hands them to the hook-free view. */
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
