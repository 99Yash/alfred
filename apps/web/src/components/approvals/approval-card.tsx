import type { SyncedActionStaging } from "@alfred/sync";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Ban, Check, Pencil, Workflow, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppButton, AppCard, AppTextarea } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { cardTitle } from "./card-spec";
import { formatJson, formatTimestamp, parseJson, shortId, triggerLabel } from "./format";
import { InputRenderer } from "./input-renderer";
import { RiskPill } from "./risk-pill";
import { ToolIcon } from "./tool-icon";

export type ApprovalDecision =
  | { decision: "approve"; editedInput?: unknown; reason?: undefined }
  | { decision: "reject"; reason: string }
  | { decision: "cancel_run"; reason: string };

export function ApprovalCard({
  staging,
  onDecide,
}: {
  staging: SyncedActionStaging;
  /** Resolves when the decision is recorded; throws with a message on failure. */
  onDecide: (decision: ApprovalDecision) => Promise<void>;
}) {
  const [draftText, setDraftText] = useState(() => formatJson(staging.proposedInput));
  const [editing, setEditing] = useState(false);
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const draft = useMemo(() => parseJson(draftText), [draftText]);
  const edited = useMemo(
    () => draftText.trim() !== formatJson(staging.proposedInput).trim(),
    [draftText, staging.proposedInput],
  );
  const displayInput = edited && draft.ok ? draft.value : staging.proposedInput;
  const reasonMissing = reason.trim().length === 0;
  const title = useMemo(
    () => cardTitle(staging.toolName, displayInput),
    [staging.toolName, displayInput],
  );

  useEffect(() => {
    if (showReason) reasonRef.current?.focus();
  }, [showReason]);

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
    <AppCard className="space-y-4">
      <div className="flex items-start gap-3">
        <ToolIcon integration={staging.integration} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-pretty text-[15px] font-medium leading-snug text-app-fg-4">
              {title}
            </h2>
            <RiskPill riskTier={staging.riskTier} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-app-fg-3">
            <Link
              to="/workflows/$workflow"
              params={{ workflow: staging.workflowSlug }}
              className={cn(
                "inline-flex items-center gap-1 rounded font-medium transition-colors hover:text-app-fg-4",
                "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
              )}
            >
              <Workflow size={12} />
              {staging.workflowName}
            </Link>
            <span className="text-app-fg-2">·</span>
            <span>{triggerLabel(staging.trigger)}</span>
            <span className="text-app-fg-2">·</span>
            <span className="font-mono">{shortId(staging.runId)}</span>
            <span className="text-app-fg-2">·</span>
            <span className="tabular-nums">{formatTimestamp(staging.createdAt)}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2">
            <code className="rounded-md bg-app-bg-2/70 px-1.5 py-0.5 font-mono text-[11px] text-app-fg-3">
              {staging.toolName}
            </code>
            {staging.brief ? (
              <p className="line-clamp-1 min-w-0 flex-1 text-[12px] italic text-app-fg-2">
                “{staging.brief}”
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {staging.recentRejection ? (
        <div className="flex items-start gap-2 rounded-xl bg-app-amber-1 px-3 py-2.5 text-xs leading-5 text-app-amber-4 shadow-[0_0_0_1px_var(--app-amber-2)]">
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

      <InputRenderer toolName={staging.toolName} input={displayInput} />

      {editing ? (
        <div>
          <label
            htmlFor={`app-approval-input-${staging.id}`}
            className="text-xs font-medium text-app-fg-3"
          >
            Edit input (JSON)
          </label>
          <AppTextarea
            id={`app-approval-input-${staging.id}`}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            spellCheck={false}
            disabled={busy}
            className={cn(
              "mt-2 min-h-[180px] font-mono text-[12px] leading-5",
              !draft.ok && "focus-visible:ring-app-red-2",
            )}
          />
          {!draft.ok ? <p className="mt-2 text-[12px] text-app-red-4">{draft.message}</p> : null}
        </div>
      ) : null}

      {showReason ? (
        <div className="space-y-2">
          <label
            htmlFor={`app-approval-reason-${staging.id}`}
            className="text-xs font-medium text-app-fg-3"
          >
            Reason for rejection
          </label>
          <AppTextarea
            id={`app-approval-reason-${staging.id}`}
            ref={reasonRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            disabled={busy}
            placeholder="Why is Alfred not doing this? (sent back to the agent)"
            className="min-h-[64px]"
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy || reasonMissing}
              onClick={() => decide({ decision: "cancel_run", reason: reason.trim() })}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-app-red-4",
                "transition-colors hover:bg-app-red-1 disabled:cursor-not-allowed disabled:opacity-40",
                "outline-none focus-visible:ring-2 focus-visible:ring-app-red-2",
              )}
            >
              <Ban size={13} />
              Reject &amp; end run
            </button>
            <AppButton
              variant="white"
              size="sm"
              leading={<XCircle size={13} />}
              disabled={busy || reasonMissing}
              onClick={() => decide({ decision: "reject", reason: reason.trim() })}
            >
              Reject
            </AppButton>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-[12px] text-app-red-4">{error}</p> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <AppButton
          variant="ghost"
          size="sm"
          leading={editing ? <X size={14} /> : <Pencil size={14} />}
          disabled={busy}
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? "Done editing" : "Edit input"}
        </AppButton>
        <div className="flex flex-wrap items-center gap-2">
          <AppButton
            variant="ghost"
            size="md"
            leading={showReason ? <X size={14} /> : <XCircle size={14} />}
            disabled={busy}
            onClick={() => setShowReason((v) => !v)}
          >
            {showReason ? "Cancel" : "Reject"}
          </AppButton>
          <AppButton
            variant="primary"
            size="md"
            leading={edited ? <Pencil size={14} /> : <Check size={14} />}
            loading={busy}
            disabled={busy || (edited && !draft.ok)}
            onClick={() =>
              decide(
                edited && draft.ok
                  ? { decision: "approve", editedInput: draft.value }
                  : { decision: "approve" },
              )
            }
          >
            {edited ? "Approve with edits" : "Approve"}
          </AppButton>
        </div>
      </div>
    </AppCard>
  );
}
