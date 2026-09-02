import type { McpRecoveryDecision, McpRecoveryOperation } from "@alfred/contracts";
import { AlertTriangle, Check, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { AppButton, AppCard } from "~/components/ui/v2";

type PendingCardAction = { kind: "resolve"; decision: McpRecoveryDecision } | { kind: "retry" };

function confirmPrompt(action: PendingCardAction, isPreparedSuccessor: boolean): string {
  if (action.kind === "retry") {
    return isPreparedSuccessor
      ? "Resume this exact MCP operation?"
      : "Try this exact MCP operation one more time?";
  }
  return action.decision === "confirmed_succeeded"
    ? "Confirm that this MCP operation completed?"
    : "Confirm that this MCP operation was not applied?";
}

/**
 * One recovery row. The confirm step is inline state on the card, not a browser
 * dialog: it renders inside the same tree, so the static-markup tests see the
 * closed state and a user sees the question next to the row it is about.
 * The list above stays hook-free so tests can call it as a plain function.
 */
function McpRecoveryCard({
  operation,
  mutationPending,
  onResolve,
  onRetry,
}: {
  operation: McpRecoveryOperation;
  mutationPending: boolean;
  onResolve: (invocationId: string, decision: McpRecoveryDecision) => void;
  onRetry: (invocationId: string) => void;
}) {
  const [pending, setPending] = useState<PendingCardAction | null>(null);
  const isPreparedSuccessor = operation.attemptLifecycle === "prepared";

  function confirm() {
    if (!pending) return;
    if (pending.kind === "retry") onRetry(operation.invocationId);
    else onResolve(operation.invocationId, pending.decision);
    setPending(null);
  }

  return (
    <AppCard className="space-y-3" padded>
      <div className="space-y-1">
        <p className="text-sm font-medium text-app-fg-4">
          {operation.connection.label} · {operation.remoteName}
        </p>
        <p className="text-xs text-app-fg-3">
          {operation.deliveryPossibleAt === null
            ? "Authorized retry is ready to resume."
            : new Date(operation.deliveryPossibleAt).toLocaleString()}
          {operation.lastError ? ` · ${operation.lastError}` : ""}
        </p>
        {operation.displayInput !== null ? (
          <pre className="max-h-32 overflow-auto rounded-lg bg-app-bg-2 p-2 text-xs text-app-fg-3">
            {JSON.stringify(operation.displayInput, null, 2)}
          </pre>
        ) : null}
      </div>
      {pending ? (
        <div className="flex flex-wrap items-center gap-2" role="group">
          <p className="text-xs text-app-fg-4">{confirmPrompt(pending, isPreparedSuccessor)}</p>
          <AppButton size="sm" variant="primary" disabled={mutationPending} onClick={confirm}>
            Confirm
          </AppButton>
          <AppButton size="sm" variant="white" onClick={() => setPending(null)}>
            Cancel
          </AppButton>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {isPreparedSuccessor ? null : (
            <>
              <AppButton
                size="sm"
                variant="white"
                leading={<Check size={13} />}
                disabled={mutationPending}
                onClick={() => setPending({ kind: "resolve", decision: "confirmed_succeeded" })}
              >
                It completed
              </AppButton>
              <AppButton
                size="sm"
                variant="white"
                leading={<X size={13} />}
                disabled={mutationPending}
                onClick={() => setPending({ kind: "resolve", decision: "confirmed_not_applied" })}
              >
                It did not apply
              </AppButton>
            </>
          )}
          <AppButton
            size="sm"
            variant="primary"
            leading={<RotateCcw size={13} />}
            disabled={mutationPending}
            onClick={() => setPending({ kind: "retry" })}
          >
            {mutationPending
              ? "Working…"
              : isPreparedSuccessor
                ? "Resume exact operation"
                : "Try exact operation"}
          </AppButton>
        </div>
      )}
    </AppCard>
  );
}

function awaitingRepairText(count: number): string {
  return count === 1
    ? "1 operation is still being recorded."
    : `${count} operations are still being recorded.`;
}

export function McpRecoveryList({
  operations,
  awaitingRepair,
  loading,
  readError,
  hasNextPage,
  loadingMore,
  mutationPending,
  mutationError,
  onReadRetry,
  onLoadMore,
  onResolve,
  onRetry,
}: {
  operations: ReadonlyArray<McpRecoveryOperation>;
  /** Rows the server knows about but has not normalized yet; see the page contract. */
  awaitingRepair: number;
  loading: boolean;
  readError: boolean;
  hasNextPage: boolean;
  loadingMore: boolean;
  mutationPending: boolean;
  mutationError: boolean;
  onReadRetry: () => void;
  onLoadMore: () => void;
  onResolve: (invocationId: string, decision: McpRecoveryDecision) => void;
  onRetry: (invocationId: string) => void;
}) {
  if (loading) {
    return (
      <p className="px-1 pt-2 text-xs text-app-fg-3" role="status">
        Loading MCP recovery operations…
      </p>
    );
  }
  if (readError) {
    return (
      <div className="flex items-center gap-2 px-1 pt-2" role="alert">
        <p className="text-xs text-red-600">Could not load MCP recovery operations.</p>
        <AppButton size="sm" variant="white" onClick={onReadRetry}>
          Retry
        </AppButton>
      </div>
    );
  }
  const awaitingLine =
    awaitingRepair > 0 ? (
      <p className="px-1 text-xs text-app-fg-3" role="status">
        {awaitingRepairText(awaitingRepair)}
      </p>
    ) : null;
  if (operations.length === 0) {
    return (
      <div className="space-y-1 pt-2">
        <p className="px-1 text-xs text-app-fg-3">No MCP operations need recovery.</p>
        {awaitingLine}
      </div>
    );
  }
  return (
    <div className="space-y-2 pt-2">
      {operations.some((operation) => operation.attemptLifecycle !== "prepared") ? (
        <div className="flex items-center gap-2 px-1 text-xs text-amber-600">
          <AlertTriangle size={14} aria-hidden />
          Some operations might have completed. Check the remote system before you continue.
        </div>
      ) : null}
      {awaitingLine}
      {operations.map((operation) => (
        <McpRecoveryCard
          key={operation.invocationId}
          operation={operation}
          mutationPending={mutationPending}
          onResolve={onResolve}
          onRetry={onRetry}
        />
      ))}
      {hasNextPage ? (
        <AppButton
          size="sm"
          variant="white"
          disabled={loadingMore || mutationPending}
          onClick={onLoadMore}
        >
          {loadingMore ? "Loading more…" : "Load more"}
        </AppButton>
      ) : null}
      {mutationError ? (
        <p className="px-1 text-xs text-red-600">Could not update the recovery operation.</p>
      ) : null}
    </div>
  );
}
