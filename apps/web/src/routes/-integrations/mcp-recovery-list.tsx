import type { McpRecoveryDecision, McpRecoveryOperation } from "@alfred/contracts";
import { AlertTriangle, Check, RotateCcw, X } from "lucide-react";
import { AppButton, AppCard } from "~/components/ui/v2";

export function McpRecoveryList({
  operations,
  loading,
  readError,
  mutationPending,
  mutationError,
  onReadRetry,
  onResolve,
  onRetry,
}: {
  operations: ReadonlyArray<McpRecoveryOperation>;
  loading: boolean;
  readError: boolean;
  mutationPending: boolean;
  mutationError: boolean;
  onReadRetry: () => void;
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
  if (operations.length === 0) {
    return <p className="px-1 pt-2 text-xs text-app-fg-3">No MCP operations need recovery.</p>;
  }
  return (
    <div className="space-y-2 pt-2">
      {operations.some((operation) => operation.attemptLifecycle !== "prepared") ? (
        <div className="flex items-center gap-2 px-1 text-xs text-amber-600">
          <AlertTriangle size={14} aria-hidden />
          Some operations might have completed. Check the remote system before you continue.
        </div>
      ) : null}
      {operations.map((operation) => {
        const isPreparedSuccessor = operation.attemptLifecycle === "prepared";
        return (
          <AppCard key={operation.invocationId} className="space-y-3" padded>
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
            <div className="flex flex-wrap gap-2">
              {isPreparedSuccessor ? null : (
                <>
                  <AppButton
                    size="sm"
                    variant="white"
                    leading={<Check size={13} />}
                    disabled={mutationPending}
                    onClick={() => {
                      if (!window.confirm("Confirm that this MCP operation completed?")) return;
                      onResolve(operation.invocationId, "confirmed_succeeded");
                    }}
                  >
                    It completed
                  </AppButton>
                  <AppButton
                    size="sm"
                    variant="white"
                    leading={<X size={13} />}
                    disabled={mutationPending}
                    onClick={() => {
                      if (!window.confirm("Confirm that this MCP operation was not applied?")) {
                        return;
                      }
                      onResolve(operation.invocationId, "confirmed_not_applied");
                    }}
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
                onClick={() => {
                  const confirmed = window.confirm(
                    isPreparedSuccessor
                      ? "Resume this exact MCP operation?"
                      : "Try this exact MCP operation one more time?",
                  );
                  if (!confirmed) return;
                  onRetry(operation.invocationId);
                }}
              >
                {mutationPending
                  ? "Working…"
                  : isPreparedSuccessor
                    ? "Resume exact operation"
                    : "Try exact operation"}
              </AppButton>
            </div>
          </AppCard>
        );
      })}
      {mutationError ? (
        <p className="px-1 text-xs text-red-600">Could not update the recovery operation.</p>
      ) : null}
    </div>
  );
}
