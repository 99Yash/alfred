import type { McpRecoveryDecision, McpRecoveryOperation } from "@alfred/contracts";
import { AlertTriangle, Check, RotateCcw, X } from "lucide-react";
import { AppButton, AppCard } from "~/components/ui/v2";

export function McpRecoveryList({
  operations,
  pendingInvocationId,
  error,
  onResolve,
  onRetry,
}: {
  operations: ReadonlyArray<McpRecoveryOperation>;
  pendingInvocationId: string | null;
  error: boolean;
  onResolve: (invocationId: string, decision: McpRecoveryDecision) => void;
  onRetry: (invocationId: string) => void;
}) {
  if (operations.length === 0) return null;
  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2 px-1 text-xs text-amber-600">
        <AlertTriangle size={14} aria-hidden />
        These operations might have completed. Check the remote system before you continue.
      </div>
      {operations.map((operation) => {
        const isPending = pendingInvocationId === operation.invocationId;
        return (
          <AppCard key={operation.invocationId} className="space-y-3" padded>
            <div className="space-y-1">
              <p className="text-sm font-medium text-app-fg-4">
                {operation.connection.label} · {operation.remoteName}
              </p>
              <p className="text-xs text-app-fg-3">
                {new Date(operation.deliveryPossibleAt).toLocaleString()}
                {operation.lastError ? ` · ${operation.lastError}` : ""}
              </p>
              {operation.displayInput !== null ? (
                <pre className="max-h-32 overflow-auto rounded-lg bg-app-bg-2 p-2 text-xs text-app-fg-3">
                  {JSON.stringify(operation.displayInput, null, 2)}
                </pre>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <AppButton
                size="sm"
                variant="white"
                leading={<Check size={13} />}
                disabled={isPending}
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
                disabled={isPending}
                onClick={() => {
                  if (!window.confirm("Confirm that this MCP operation was not applied?")) return;
                  onResolve(operation.invocationId, "confirmed_not_applied");
                }}
              >
                It did not apply
              </AppButton>
              <AppButton
                size="sm"
                variant="primary"
                leading={<RotateCcw size={13} />}
                disabled={isPending}
                onClick={() => {
                  if (!window.confirm("Try this exact MCP operation one more time?")) return;
                  onRetry(operation.invocationId);
                }}
              >
                {isPending ? "Working…" : "Try exact operation"}
              </AppButton>
            </div>
          </AppCard>
        );
      })}
      {error ? (
        <p className="px-1 text-xs text-red-600">Could not update the recovery operation.</p>
      ) : null}
    </div>
  );
}
