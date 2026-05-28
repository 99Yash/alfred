import type { SyncedActionStaging } from "@alfred/sync";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Ban, Check, Pencil, Workflow, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { VsButton, VsCard, VsPill, VsTextarea } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";
import { formatJson, formatTimestamp, parseJson, shortId } from "./format";
import { InputRenderer } from "./input-renderer";
import { RiskPill } from "./risk-pill";
import { ToolIcon } from "./tool-icon";

export type ApprovalDecision =
  | { decision: "approve"; editedInput?: unknown; reason?: undefined }
  | { decision: "reject"; reason: string }
  | { decision: "cancel_run"; reason: string };

const APPROVE_LEADING = <Check size={14} />;
const APPROVE_WITH_EDITS_LEADING = <Pencil size={14} />;
const REJECT_LEADING = <XCircle size={14} />;
const REJECT_END_LEADING = <Ban size={14} />;

export function ApprovalCard({
  staging,
  onDecide,
}: {
  staging: SyncedActionStaging;
  /** Resolves when the decision is recorded; throws with a message on failure. */
  onDecide: (decision: ApprovalDecision) => Promise<void>;
}) {
  const [draftText, setDraftText] = useState(() => formatJson(staging.proposedInput));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = useMemo(() => parseJson(draftText), [draftText]);
  const edited = useMemo(
    () => draftText.trim() !== formatJson(staging.proposedInput).trim(),
    [draftText, staging.proposedInput],
  );
  const reasonMissing = reason.trim().length === 0;

  const decide = async (decision: ApprovalDecision) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDecide(decision);
      // On success the row leaves the pending queue and Replicache removes the
      // card; no local state cleanup needed.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record decision");
      setBusy(false);
    }
  };

  return (
    <VsCard className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <ToolIcon integration={staging.integration} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[15px] font-medium text-vs-fg-4">{staging.toolName}</h2>
              <RiskPill riskTier={staging.riskTier} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-vs-fg-3">
              <Link
                to="/workflows/$workflow"
                params={{ workflow: staging.workflowSlug }}
                className={cn(
                  "inline-flex items-center gap-1 rounded transition-colors hover:text-vs-fg-4",
                  "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
                )}
              >
                <Workflow size={12} />
                {staging.workflowSlug}
              </Link>
              <span className="text-vs-fg-2">·</span>
              <span className="font-mono">{shortId(staging.runId)}</span>
              <span className="text-vs-fg-2">·</span>
              <span>{formatTimestamp(staging.createdAt)}</span>
            </div>
          </div>
        </div>
        <VsPill tone="sky">{staging.integration}</VsPill>
      </div>

      {staging.recentRejection ? (
        <div className="flex items-start gap-2 rounded-xl bg-vs-amber-1 px-3 py-2.5 text-xs leading-5 text-vs-amber-4 shadow-[0_0_0_1px_var(--vs-amber-2)]">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">
              Last {staging.toolName} rejection was{" "}
              {formatTimestamp(staging.recentRejection.decidedAt)}
            </p>
            {staging.recentRejection.reason ? (
              <p className="mt-0.5 break-words opacity-80">{staging.recentRejection.reason}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <InputRenderer toolName={staging.toolName} input={staging.proposedInput} />

      <div>
        <label
          htmlFor={`vs-approval-input-${staging.id}`}
          className="text-xs font-medium text-vs-fg-3"
        >
          Input JSON
        </label>
        <VsTextarea
          id={`vs-approval-input-${staging.id}`}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          spellCheck={false}
          disabled={busy}
          className={cn(
            "mt-2 min-h-[180px] font-mono text-[12px] leading-5",
            !draft.ok && "focus-visible:ring-vs-red-2",
          )}
        />
        {!draft.ok ? <p className="mt-2 text-[12px] text-vs-red-4">{draft.message}</p> : null}
      </div>

      <div>
        <label
          htmlFor={`vs-approval-reason-${staging.id}`}
          className="text-xs font-medium text-vs-fg-3"
        >
          Rejection reason
        </label>
        <VsTextarea
          id={`vs-approval-reason-${staging.id}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          disabled={busy}
          className="mt-2 min-h-[72px]"
        />
      </div>

      {error ? <p className="text-[12px] text-vs-red-4">{error}</p> : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <VsButton
          variant="primary"
          size="md"
          leading={APPROVE_LEADING}
          disabled={busy}
          onClick={() => decide({ decision: "approve" })}
        >
          Approve
        </VsButton>
        <VsButton
          variant="white"
          size="md"
          leading={APPROVE_WITH_EDITS_LEADING}
          disabled={busy || !draft.ok || !edited}
          onClick={() => draft.ok && decide({ decision: "approve", editedInput: draft.value })}
        >
          Approve with edits
        </VsButton>
        <VsButton
          variant="ghost"
          size="md"
          leading={REJECT_LEADING}
          disabled={busy || reasonMissing}
          onClick={() => decide({ decision: "reject", reason: reason.trim() })}
        >
          Reject
        </VsButton>
        <VsButton
          variant="destructive"
          size="md"
          leading={REJECT_END_LEADING}
          disabled={busy || reasonMissing}
          onClick={() => decide({ decision: "cancel_run", reason: reason.trim() })}
        >
          Reject and end run
        </VsButton>
      </div>
    </VsCard>
  );
}
