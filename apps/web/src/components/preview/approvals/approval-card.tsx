import { Link } from "@tanstack/react-router";
import { AlertTriangle, Ban, Check, Pencil, Workflow, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { VsButton, VsCard, VsPill, VsTextarea } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";
import { formatJson, formatTimestamp, parseJson, shortId } from "./helpers";
import { InputPreview } from "./input-preview";
import { RiskPill } from "./risk-pill";
import { ToolIcon } from "./tool-icon";
import type { LocalApproval } from "./types";

// Hoisted so the leading-icon props are stable across renders — keeps
// VsButton from receiving a freshly constructed JSX node every time
// ApprovalCard re-renders (the form state changes on every keystroke).
const APPROVE_LEADING = <Check size={14} />;
const APPROVE_WITH_EDITS_LEADING = <Pencil size={14} />;
const REJECT_LEADING = <XCircle size={14} />;
const REJECT_END_LEADING = <Ban size={14} />;

export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: LocalApproval;
  onResolve: () => void;
}) {
  const [draftText, setDraftText] = useState(() => formatJson(approval.proposedInput));
  const [reason, setReason] = useState("");

  const draft = useMemo(() => parseJson(draftText), [draftText]);
  const reasonRequired = reason.trim().length === 0;

  return (
    <VsCard className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <ToolIcon toolName={approval.toolName} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[15px] font-medium text-vs-fg-4">
                {approval.toolName}
              </h2>
              <RiskPill riskTier={approval.riskTier} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-vs-fg-3">
              <Link
                to="/preview/workflows/$workflow"
                params={{ workflow: approval.workflowSlug }}
                className={cn(
                  "inline-flex items-center gap-1 rounded transition-colors hover:text-vs-fg-4",
                  "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
                )}
              >
                <Workflow size={12} />
                {approval.workflowSlug}
              </Link>
              <span className="text-vs-fg-2">·</span>
              <span className="font-mono">{shortId(approval.runId)}</span>
              <span className="text-vs-fg-2">·</span>
              <span>{formatTimestamp(approval.createdAt)}</span>
            </div>
          </div>
        </div>
        <VsPill tone="sky">{approval.integration}</VsPill>
      </div>

      {approval.recentRejection ? (
        <div className="flex items-start gap-2 rounded-xl bg-vs-amber-1 px-3 py-2.5 text-xs leading-5 text-vs-amber-4 shadow-[0_0_0_1px_var(--vs-amber-2)]">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">
              Last {approval.toolName} rejection was{" "}
              {formatTimestamp(approval.recentRejection.decidedAt)}
            </p>
            <p className="mt-0.5 break-words opacity-80">{approval.recentRejection.reason}</p>
          </div>
        </div>
      ) : null}

      <InputPreview toolName={approval.toolName} input={approval.proposedInput} />

      <div>
        <label
          htmlFor={`vs-approval-input-${approval.id}`}
          className="text-xs font-medium text-vs-fg-3"
        >
          Input JSON
        </label>
        <VsTextarea
          id={`vs-approval-input-${approval.id}`}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          spellCheck={false}
          className={cn(
            "mt-2 min-h-[180px] font-mono text-[12px] leading-5",
            !draft.ok && "focus-visible:ring-vs-red-2",
          )}
        />
        {!draft.ok ? (
          <p className="mt-2 text-[12px] text-vs-red-4">{draft.message}</p>
        ) : null}
      </div>

      <div>
        <label
          htmlFor={`vs-approval-reason-${approval.id}`}
          className="text-xs font-medium text-vs-fg-3"
        >
          Rejection reason
        </label>
        <VsTextarea
          id={`vs-approval-reason-${approval.id}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="mt-2 min-h-[72px]"
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <VsButton
          variant="primary"
          size="md"
          leading={APPROVE_LEADING}
          onClick={onResolve}
        >
          Approve
        </VsButton>
        <VsButton
          variant="white"
          size="md"
          leading={APPROVE_WITH_EDITS_LEADING}
          disabled={!draft.ok}
          onClick={onResolve}
        >
          Approve with edits
        </VsButton>
        <VsButton
          variant="ghost"
          size="md"
          leading={REJECT_LEADING}
          disabled={reasonRequired}
          onClick={onResolve}
        >
          Reject
        </VsButton>
        <VsButton
          variant="destructive"
          size="md"
          leading={REJECT_END_LEADING}
          disabled={reasonRequired}
          onClick={onResolve}
        >
          Reject and end run
        </VsButton>
      </div>
    </VsCard>
  );
}
