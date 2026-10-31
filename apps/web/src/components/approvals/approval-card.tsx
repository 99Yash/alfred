import type { SyncedActionStaging } from "@alfred/sync";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Ban, Check, Pencil, RefreshCw, Workflow, X } from "lucide-react";
import { AppButton, AppCard, AppTextarea } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import {
  approveButtonLabel,
  MAY_HAVE_RUN_NOTICE,
  reviseButtonLabel,
  toolChipLabel,
} from "./card-spec";
import { formatDateTime } from "~/lib/date-format";
import { shortId, triggerLabel } from "./format";
import { ApprovalInputEditor } from "./input-editor";
import { RiskPill } from "./risk-pill";
import { ToolIcon } from "./tool-icon";
import type { DecisionOutcome } from "./decide-approval";
import { useApprovalDecision, type WriteDecision } from "./use-approval-decision";

export type { WriteDecision } from "./use-approval-decision";

// Hoisted so `leading` gets a stable element.
const ICON_X = <X size={14} />;

const ICON_PENCIL = <Pencil size={14} />;

const ICON_REVISE = <RefreshCw size={14} />;

const ICON_REVISE_SM = <RefreshCw size={13} />;

const ICON_CHECK = <Check size={14} />;

/**
 * One staged write in the approvals queue. Questions get `QuestionApprovalCard`
 * (ADR-0099), so the write-only decision type rules out a reason-less reject.
 */
export function ApprovalCard({
  staging,
  onDecide,
}: {
  staging: SyncedActionStaging;
  /** Throws with a message on failure. */
  onDecide: (decision: WriteDecision) => Promise<DecisionOutcome>;
}) {
  const {
    draftInput,
    setDraftInput,
    showReason,
    setShowReason,
    reason,
    setReason,
    reasonRef,
    busy,
    error,
    edited,
    reasonMissing,
    title,
    approveDecision,
    run,
  } = useApprovalDecision(staging);

  // Replicache removes a decided card; a restaged one re-seeds with its new input. Either way `busy` needs no cleanup.
  const decide = (decision: WriteDecision) =>
    run(async () => {
      await onDecide(decision);
    });

  return (
    <AppCard className="space-y-4">
      <div className="flex items-start gap-3">
        <ToolIcon integration={staging.integration} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-[15px] leading-snug font-medium text-pretty text-app-fg-4">
              {title}
            </h2>
            <RiskPill riskTier={staging.riskTier} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-app-fg-3">
            <Link
              to="/workflows/$workflow"
              params={{ workflow: staging.workflowSlug }}
              className={cn(
                "inline-flex items-center gap-1 rounded-control-xs font-medium transition-colors hover:text-app-fg-4",
                "app-focus",
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
            <span className="tabular-nums">
              {formatDateTime(staging.createdAt, { today: "sentence" })}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2">
            <span className="rounded-control-sm bg-app-bg-2/70 px-1.5 py-0.5 text-[11px] font-medium text-app-fg-3">
              {toolChipLabel(staging.toolName)}
            </span>
            {staging.brief ? (
              <p className="line-clamp-1 min-w-0 flex-1 text-[12px] text-app-fg-2 italic">
                “{staging.brief}”
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {staging.mayHaveRun ? (
        <div className="flex items-start gap-2 rounded-surface bg-app-amber-1 px-3 py-2.5 text-xs leading-5 text-app-amber-4 shadow-[0_0_0_1px_var(--app-amber-2)]">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">{MAY_HAVE_RUN_NOTICE.title}</p>
            <p className="mt-0.5 opacity-80">{MAY_HAVE_RUN_NOTICE.detail}</p>
          </div>
        </div>
      ) : null}

      {staging.recentRejection ? (
        <div className="flex items-start gap-2 rounded-surface bg-app-amber-1 px-3 py-2.5 text-xs leading-5 text-app-amber-4 shadow-[0_0_0_1px_var(--app-amber-2)]">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">
              Last rejected{" "}
              {formatDateTime(staging.recentRejection.decidedAt, { today: "sentence" })}
            </p>
            {staging.recentRejection.reason ? (
              <p className="mt-0.5 wrap-break-word opacity-80">{staging.recentRejection.reason}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Fields are always editable; an edit makes the button say "Approve changes". */}
      <ApprovalInputEditor
        toolName={staging.toolName}
        value={draftInput}
        onChange={setDraftInput}
        disabled={busy}
        idPrefix={`app-approval-input-${staging.id}`}
      />

      {showReason ? (
        <div className="space-y-2">
          <label
            htmlFor={`app-approval-reason-${staging.id}`}
            className="text-xs font-medium text-app-fg-3"
          >
            What should Alfred change?
          </label>
          <AppTextarea
            id={`app-approval-reason-${staging.id}`}
            ref={reasonRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            disabled={busy}
            placeholder="Tell Alfred what to change or avoid."
            className="min-h-[64px]"
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy || reasonMissing}
              onClick={() =>
                void decide({
                  decision: "cancel_run",
                  expectedRowVersion: staging.rowVersion,
                  reason: reason.trim(),
                })
              }
              className={cn(
                "inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-[12px] font-medium text-app-red-4",
                "transition-colors hover:bg-app-red-1 disabled:cursor-not-allowed disabled:opacity-40",
                "app-focus [--app-accent-ring:var(--app-red-2)]",
              )}
            >
              <Ban size={13} />
              End run
            </button>
            <AppButton
              variant="white"
              size="sm"
              leading={ICON_REVISE_SM}
              disabled={busy || reasonMissing}
              onClick={() =>
                void decide({
                  decision: "reject",
                  expectedRowVersion: staging.rowVersion,
                  reason: reason.trim(),
                })
              }
            >
              Send revision
            </AppButton>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-[12px] text-app-red-4">{error}</p> : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Revise returns the action with a note and the run continues. End run stops it. */}
        <AppButton
          variant="ghost"
          size="md"
          leading={showReason ? ICON_X : ICON_REVISE}
          disabled={busy}
          onClick={() => setShowReason((v) => !v)}
        >
          {showReason ? "Cancel" : reviseButtonLabel(staging.mayHaveRun)}
        </AppButton>
        <AppButton
          variant="primary"
          size="md"
          leading={edited ? ICON_PENCIL : ICON_CHECK}
          loading={busy}
          disabled={busy}
          onClick={() => void decide(approveDecision())}
        >
          {approveButtonLabel(staging.toolName, staging.riskTier, edited, staging.mayHaveRun)}
        </AppButton>
      </div>
    </AppCard>
  );
}
