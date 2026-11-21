import {
  APPROVAL_CONTROL_LABELS,
  enumGuard,
  humanizeSlug,
  isToolRiskTier,
  MCP_TOOL_POLICY_NOTE_MAX,
  serverToolRuleOf,
  storedServerToolRuleOf,
  mcpEffectClassValues,
  mcpRetryContractValues,
  TOOL_OUTPUT_KINDS,
  TOOL_READ_CLASSES,
  TOOL_RISK_TIERS,
  toMessage,
  type ExternalToolRef,
  type IntegrationSlug,
  type McpEffectClass,
  type McpServerToolRef,
  type McpRetryContract,
  type ToolOutputKind,
  type ToolReadClass,
  type ToolRiskTier,
} from "@alfred/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppButton, AppSelect, AppSwitch, type AppSelectOption } from "~/components/ui/v2";
import { useAppForm } from "~/components/ui/v2/form";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import { MCP_TOOL_POLICY_QUERY_KEY, type McpToolPolicyState } from "./helpers";

/** `note`, `readClass`, and `outputKind` are `null` when blank, as the contract expects. */
interface McpToolPolicyDraft {
  readonly riskTier: ToolRiskTier;
  readonly effectClass: McpEffectClass;
  readonly retryContract: McpRetryContract;
  readonly readClass: ToolReadClass | null;
  readonly outputKind: ToolOutputKind | null;
  readonly note: string | null;
}

/**
 * First-review defaults, matching the column defaults. `riskTier` has no default:
 * the floor lives on the server (`MCP_CALL_RISK_FLOOR`), and a browser copy would drift.
 */
const MCP_TOOL_POLICY_CONSERVATIVE_DEFAULTS = {
  effectClass: "unknown",
  retryContract: "never",
  readClass: null,
  outputKind: null,
  note: null,
} satisfies Omit<McpToolPolicyDraft, "riskTier">;

const isEffectClass = enumGuard(mcpEffectClassValues);

const isRetryContract = enumGuard(mcpRetryContractValues);

const isReadClass = enumGuard(TOOL_READ_CLASSES);

const isOutputKind = enumGuard(TOOL_OUTPUT_KINDS);

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

const READ_CLASS_LABELS = {
  secret: "Can show a secret",
  ordinary: "Shows no secret",
} satisfies Record<ToolReadClass, string>;

const READ_CLASS_OPTIONS: ReadonlyArray<AppSelectOption> = TOOL_READ_CLASSES.map((value) => ({
  value,
  label: READ_CLASS_LABELS[value],
}));

const OUTPUT_KIND_LABELS = {
  structured: "Structured data",
  binary: "File content",
} satisfies Record<ToolOutputKind, string>;

const OUTPUT_KIND_OPTIONS: ReadonlyArray<AppSelectOption> = TOOL_OUTPUT_KINDS.map((value) => ({
  value,
  label: OUTPUT_KIND_LABELS[value],
}));

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
        readClass: draft.readClass,
        outputKind: draft.outputKind,
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
    readClass: policy.readClass,
    outputKind: policy.outputKind,
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

/** The form's own values. A select with no value holds `undefined`; the draft holds `null`. */
interface McpToolPolicyFormValues {
  riskTier: ToolRiskTier | undefined;
  effectClass: McpEffectClass;
  retryContract: McpRetryContract;
  readClass: ToolReadClass | undefined;
  outputKind: ToolOutputKind | undefined;
  note: string;
}

/**
 * Local form state only. The container keys it by tool and state, so new server values remount
 * it. The read class and the output kind apply only to a read, so the contract refuses them on
 * any other effect, and the submit drops them.
 */
function McpToolPolicyForm({ initial, pending, onSave, onClear }: McpToolPolicyFormProps) {
  const defaultValues: McpToolPolicyFormValues = {
    riskTier: initial.riskTier,
    effectClass: initial.effectClass ?? "unknown",
    retryContract: initial.retryContract ?? "never",
    readClass: initial.readClass ?? undefined,
    outputKind: initial.outputKind ?? undefined,
    note: initial.note ?? "",
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => {
      if (value.riskTier === undefined) return;
      const trimmed = value.note.trim();
      const read = value.effectClass === "read";

      onSave({
        riskTier: value.riskTier,
        effectClass: value.effectClass,
        retryContract: value.retryContract,
        readClass: read ? (value.readClass ?? null) : null,
        outputKind: read ? (value.outputKind ?? null) : null,
        note: trimmed.length > 0 ? trimmed : null,
      });
    },
  });

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <div className="grid grid-cols-3 gap-2">
        <form.Field name="riskTier">
          {(field) => (
            <AppSelect
              label="Approval tier"
              placeholder="Select a tier"
              value={field.state.value}
              options={RISK_TIER_OPTIONS}
              disabled={pending}
              onChange={(value) => {
                if (value !== undefined && isToolRiskTier(value)) field.handleChange(value);
              }}
            />
          )}
        </form.Field>
        <form.Field name="effectClass">
          {(field) => (
            <AppSelect
              label="Effect"
              value={field.state.value}
              options={EFFECT_CLASS_OPTIONS}
              disabled={pending}
              onChange={(value) => {
                if (value !== undefined && isEffectClass(value)) field.handleChange(value);
              }}
            />
          )}
        </form.Field>
        <form.Field name="retryContract">
          {(field) => (
            <AppSelect
              label="Retry"
              value={field.state.value}
              options={RETRY_CONTRACT_OPTIONS}
              disabled={pending}
              onChange={(value) => {
                if (value !== undefined && isRetryContract(value)) field.handleChange(value);
              }}
            />
          )}
        </form.Field>
      </div>
      <form.Subscribe selector={(state) => state.values.effectClass === "read"}>
        {(read) => (
          <div className="space-y-1">
            <div className="grid grid-cols-2 gap-2">
              <form.Field name="readClass">
                {(field) => (
                  <AppSelect
                    label="Secrets"
                    placeholder="Not set"
                    clearable
                    value={read ? field.state.value : undefined}
                    options={READ_CLASS_OPTIONS}
                    disabled={pending || !read}
                    onChange={(value) => {
                      field.handleChange(
                        value !== undefined && isReadClass(value) ? value : undefined,
                      );
                    }}
                  />
                )}
              </form.Field>
              <form.Field name="outputKind">
                {(field) => (
                  <AppSelect
                    label="Output"
                    placeholder="Not set"
                    clearable
                    value={read ? field.state.value : undefined}
                    options={OUTPUT_KIND_OPTIONS}
                    disabled={pending || !read}
                    onChange={(value) => {
                      field.handleChange(
                        value !== undefined && isOutputKind(value) ? value : undefined,
                      );
                    }}
                  />
                )}
              </form.Field>
            </div>
            <p className="text-xs text-app-fg-3">
              {read
                ? "Under Gated, a read that shows no secret runs without asking. Structured output can run in a script."
                : "Set the effect to Read to classify this tool."}
            </p>
          </div>
        )}
      </form.Subscribe>
      <form.AppField name="note">
        {(field) => (
          <field.TextAreaField
            aria-label="Review note"
            maxLength={MCP_TOOL_POLICY_NOTE_MAX}
            placeholder="Why this tier?"
            disabled={pending}
          />
        )}
      </form.AppField>
      <div className="flex items-center gap-1">
        <form.Subscribe selector={(state) => state.values.riskTier === undefined}>
          {(noTier) => (
            <AppButton type="submit" size="lg" variant="primary" disabled={pending || noTier}>
              Save review
            </AppButton>
          )}
        </form.Subscribe>
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
  const { state } = controller;

  const ruleTarget =
    state?.status === "reviewed" || state?.status === "unreviewed" || state?.status === "drifted"
      ? state.ruleTarget
      : undefined;

  return (
    <>
      <McpToolPolicyReviewView {...controller} />
      {ruleTarget === undefined ? null : (
        <ServerToolRuleSwitch
          integration={ruleTarget.integration}
          serverTool={{
            connectionId,
            remoteName: toolRef.remoteName,
            descriptorHash: ruleTarget.descriptorHash,
          }}
        />
      )}
    </>
  );
}

/**
 * "Always allow this action" for one server tool (ADR-0130 amendment (c)). The rule binds to the
 * descriptor that the owner inspected, so a changed tool asks again. Off removes the rule, and the
 * integration mode governs the tool again. A `high` call still asks.
 */
function ServerToolRuleSwitch({
  integration,
  serverTool,
}: {
  integration: IntegrationSlug;
  serverTool: McpServerToolRef;
}) {
  const { policy, setServerToolMode, loading } = useActionPolicy();
  const [error, setError] = useState<string | null>(null);
  const id = `server-tool-rule-${serverTool.connectionId}-${serverTool.remoteName}`;

  if (policy === null) return null;

  const allowed =
    serverToolRuleOf(policy.integrationRules, integration, serverTool)?.mode === "autonomy";

  const stored = storedServerToolRuleOf(policy.integrationRules, integration, serverTool);

  const changed = stored !== undefined && stored.descriptorHash !== serverTool.descriptorHash;

  return (
    <div className="space-y-1 border-t border-app-bg-3 pt-4">
      <div className="flex items-start gap-3">
        <AppSwitch
          id={id}
          checked={allowed}
          disabled={loading}
          onCheckedChange={(next) => {
            setError(null);
            setServerToolMode(integration, serverTool, next === true ? "autonomy" : null).catch(
              (cause: unknown) => setError(toMessage(cause)),
            );
          }}
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0">
          <label htmlFor={id} className="block text-xs font-medium text-app-fg-4">
            {APPROVAL_CONTROL_LABELS.alwaysAllowAction}
          </label>
          <p className="mt-0.5 text-xs text-app-fg-3">
            {allowed
              ? "Alfred runs this tool without asking. If the server changes it, Alfred asks again. High-risk calls still ask."
              : "Only this tool on this server. Other tools keep their rule."}
          </p>
          {changed ? (
            <p className="mt-0.5 text-xs text-app-amber-4" role="status">
              The server changed this tool, so the earlier rule no longer applies.
            </p>
          ) : null}
        </div>
      </div>
      {error ? (
        <p className="text-xs text-app-red-4" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
