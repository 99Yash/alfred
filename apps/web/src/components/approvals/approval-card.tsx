import type { SyncedActionStaging } from "@alfred/sync";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Ban, Check, Pencil, Workflow, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppButton, AppCard, AppTextarea } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { cardTitle, toolChipLabel } from "./card-spec";
import { formatJson, formatTimestamp, shortId, triggerLabel } from "./format";
import { ApprovalInputEditor } from "./input-editor";
import { InputRenderer } from "./input-renderer";
import { RiskPill } from "./risk-pill";
import { ToolIcon } from "./tool-icon";

// Hoisted so the `leading` props below don't allocate a fresh element per render.
const ICON_X = <X size={14} />;
const ICON_PENCIL = <Pencil size={14} />;
const ICON_XCIRCLE = <XCircle size={14} />;
const ICON_XCIRCLE_SM = <XCircle size={13} />;
const ICON_CHECK = <Check size={14} />;

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
  const [draftInput, setDraftInput] = useState<unknown>(() => staging.proposedInput);
  const [editing, setEditing] = useState(false);
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const edited = useMemo(
    () => formatJson(draftInput).trim() !== formatJson(staging.proposedInput).trim(),
    [draftInput, staging.proposedInput],
  );
  const displayInput = edited ? draftInput : staging.proposedInput;
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
            <span className="rounded-md bg-app-bg-2/70 px-1.5 py-0.5 text-[11px] font-medium text-app-fg-3">
              {toolChipLabel(staging.toolName)}
            </span>
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
              Last rejected {formatTimestamp(staging.recentRejection.decidedAt)}
            </p>
            {staging.recentRejection.reason ? (
              <p className="mt-0.5 break-words opacity-80">{staging.recentRejection.reason}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {editing ? (
        <ApprovalInputEditor
          toolName={staging.toolName}
          value={draftInput}
          onChange={setDraftInput}
          disabled={busy}
          idPrefix={`app-approval-input-${staging.id}`}
        />
      ) : (
        <InputRenderer toolName={staging.toolName} input={displayInput} />
      )}

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
              leading={ICON_XCIRCLE_SM}
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
          leading={editing ? ICON_X : ICON_PENCIL}
          disabled={busy}
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? "Done" : "Adjust"}
        </AppButton>
        <div className="flex flex-wrap items-center gap-2">
          <AppButton
            variant="ghost"
            size="md"
            leading={showReason ? ICON_X : ICON_XCIRCLE}
            disabled={busy}
            onClick={() => setShowReason((v) => !v)}
          >
            {showReason ? "Cancel" : "Reject"}
          </AppButton>
          <AppButton
            variant="primary"
            size="md"
            leading={edited ? ICON_PENCIL : ICON_CHECK}
            loading={busy}
            disabled={busy}
            onClick={() =>
              decide(
                edited ? { decision: "approve", editedInput: draftInput } : { decision: "approve" },
              )
            }
          >
            {edited ? "Approve changes" : "Approve"}
          </AppButton>
        </div>
      </div>
    </AppCard>
  );
}
