import type { ToolRiskTier } from "@alfred/contracts";
import type { SyncedActionStaging } from "@alfred/sync";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Pencil,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApprovalDecision } from "~/components/approvals/approval-card";
import { cardTitle, toolChipLabel } from "~/components/approvals/card-spec";
import { formatJson, formatTimestamp } from "~/components/approvals/format";
import { ApprovalInputEditor } from "~/components/approvals/input-editor";
import { InputRenderer } from "~/components/approvals/input-renderer";
import { RiskPill } from "~/components/approvals/risk-pill";
import { ToolIcon } from "~/components/approvals/tool-icon";
import { AppButton, AppTextarea } from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { callToast, toast } from "~/lib/toast";
import { cn } from "~/lib/utils";

// Hoisted so the `leading` props below don't allocate a fresh element per render.
const ICON_X = <X size={13} />;
const ICON_PENCIL = <Pencil size={13} />;
const ICON_BAN = <Ban size={13} />;
const ICON_XCIRCLE = <XCircle size={13} />;
const ICON_CHECK = <Check size={13} />;

export function ChatApprovalTray({
  runId,
  approvals,
  awaitingApproval,
  preview = false,
}: {
  runId: string | undefined;
  approvals: readonly SyncedActionStaging[];
  awaitingApproval: boolean;
  /** Styleguide-only: render with all interactions local — no toast, no audio, no API. */
  preview?: boolean;
}) {
  const ordered = useMemo(
    () => approvals.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [approvals],
  );
  const [index, setIndex] = useState(0);
  const [recentDecision, setRecentDecision] = useState<"approve" | "reject" | "cancel_run" | null>(
    null,
  );
  const previousRunIdRef = useRef(runId);

  if (runId !== previousRunIdRef.current) {
    previousRunIdRef.current = runId;
    setIndex(0);
    setRecentDecision(null);
  }

  useEffect(() => {
    if (index >= ordered.length) setIndex(Math.max(0, ordered.length - 1));
  }, [index, ordered.length]);

  if (!runId) return null;

  const active = ordered[index] ?? null;

  if (!active) {
    if (!awaitingApproval) return null;
    return (
      <div className="app-frost-overlay animate-chat-in rounded-2xl px-4 py-3">
        <div className="flex items-center gap-2 text-[13px] text-app-fg-3">
          <Loader2 size={14} className="animate-spin" />
          <span>{recentDecision ? "Resuming after your decision…" : "Loading approval…"}</span>
        </div>
      </div>
    );
  }

  return (
    <ApprovalStep
      staging={active}
      step={index + 1}
      total={ordered.length}
      onPrev={() => setIndex((v) => Math.max(0, v - 1))}
      onNext={() => setIndex((v) => Math.min(ordered.length - 1, v + 1))}
      onDecision={(decision) => setRecentDecision(decision)}
      preview={preview}
    />
  );
}

function ApprovalStep({
  staging,
  step,
  total,
  onPrev,
  onNext,
  onDecision,
  preview = false,
}: {
  staging: SyncedActionStaging;
  step: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onDecision: (decision: ApprovalDecision["decision"]) => void;
  preview?: boolean;
}) {
  const [draftInput, setDraftInput] = useState<unknown>(() => staging.proposedInput);
  const [editing, setEditing] = useState(false);
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousStagingRef = useRef({
    id: staging.id,
    proposedInput: staging.proposedInput,
  });
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const notifiedIdsRef = useRef<Set<string>>(new Set());

  if (
    staging.id !== previousStagingRef.current.id ||
    staging.proposedInput !== previousStagingRef.current.proposedInput
  ) {
    previousStagingRef.current = { id: staging.id, proposedInput: staging.proposedInput };
    setDraftInput(staging.proposedInput);
    setEditing(false);
    setShowReason(false);
    setReason("");
    setBusy(false);
    setDecided(false);
    setError(null);
  }

  useEffect(() => {
    if (showReason) reasonRef.current?.focus();
  }, [showReason]);

  const edited = useMemo(
    () => formatJson(draftInput).trim() !== formatJson(staging.proposedInput).trim(),
    [draftInput, staging.proposedInput],
  );
  const displayInput = edited ? draftInput : staging.proposedInput;
  const title = useMemo(
    () => cardTitle(staging.toolName, displayInput),
    [staging.toolName, displayInput],
  );
  const reasonMissing = reason.trim().length === 0;

  useEffect(() => {
    if (preview) return;
    if (notifiedIdsRef.current.has(staging.id)) return;
    notifiedIdsRef.current.add(staging.id);
    callToast({
      message: "Approval needed",
      description: title,
      icon: <ShieldCheck size={14} className="text-app-purple-3" />,
    });
    const audio = new Audio("/sounds/run-finished.mp3");
    audio.volume = 0.42;
    void audio.play().catch(() => {
      // Browsers can block audio until the page has user activation. The
      // inline tray remains the source of truth when that happens.
    });
  }, [preview, staging.id, title]);

  const decide = async (decision: ApprovalDecision) => {
    if (busy || decided) return;
    if (preview) return;
    setBusy(true);
    setError(null);
    try {
      const { error: responseError } = await client.api
        .approvals({ stagingId: staging.id })
        .decision.post(decision);
      if (responseError) {
        throw new Error(
          responseErrorMessage(responseError.value, responseError.status, "Approval decision"),
        );
      }
      setDecided(true);
      onDecision(decision.decision);
      const recorded = decision.decision === "approve" ? toast.success : toast.info;
      recorded({
        message: decision.decision === "approve" ? "Approval recorded" : "Rejection recorded",
        description: "Alfred is resuming the run.",
        position: "top-center",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record decision");
      setBusy(false);
    }
  };

  const approveLabel = approvalLabel(staging.riskTier, edited);
  const policy = policyCopy(staging.riskTier);

  return (
    <section
      aria-label="Approval required"
      className={cn("app-frost-overlay animate-chat-in overflow-hidden rounded-2xl")}
    >
      <div className="flex items-start gap-3 px-3 py-3 sm:px-4">
        <ToolIcon integration={staging.integration} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 truncate text-[15px] font-medium leading-6 text-app-fg-4">
              {title}
            </p>
            <RiskPill riskTier={staging.riskTier} />
          </div>
          <p className="mt-1 max-w-[42rem] text-pretty text-[12px] leading-5 text-app-fg-3">
            {policy}
          </p>
        </div>
        {total > 1 ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <StepButton
              label="Previous approval"
              disabled={step <= 1 || busy || decided}
              onClick={onPrev}
            >
              <ChevronLeft size={14} />
            </StepButton>
            <span className="min-w-10 text-center text-[12px] tabular-nums text-app-fg-3">
              {step}/{total}
            </span>
            <StepButton
              label="Next approval"
              disabled={step >= total || busy || decided}
              onClick={onNext}
            >
              <ChevronRight size={14} />
            </StepButton>
          </div>
        ) : null}
      </div>

      <div className="px-3 pb-3 sm:px-4">
        {editing ? (
          <ApprovalInputEditor
            toolName={staging.toolName}
            value={draftInput}
            onChange={setDraftInput}
            disabled={busy || decided}
            idPrefix={`chat-approval-input-${staging.id}`}
          />
        ) : (
          <InputRenderer toolName={staging.toolName} input={displayInput} />
        )}

        {staging.recentRejection ? (
          <div className="mt-2 flex items-start gap-2 rounded-xl bg-app-amber-1 px-3 py-2 text-[12px] leading-5 text-app-amber-4 shadow-[0_0_0_1px_var(--app-amber-2)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <p className="min-w-0">
              Last rejected {formatTimestamp(staging.recentRejection.decidedAt)}
              {staging.recentRejection.reason ? `: ${staging.recentRejection.reason}` : "."}
            </p>
          </div>
        ) : null}

        {showReason ? (
          <div className="mt-3">
            <label
              htmlFor={`chat-approval-reason-${staging.id}`}
              className="text-[12px] font-medium text-app-fg-3"
            >
              Reason for rejection
            </label>
            <AppTextarea
              id={`chat-approval-reason-${staging.id}`}
              ref={reasonRef}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              disabled={busy || decided}
              placeholder="Tell Alfred what to change or avoid."
              className="mt-2 min-h-16"
            />
          </div>
        ) : null}

        {error ? <p className="mt-2 text-[12px] text-app-red-4">{error}</p> : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 bg-app-bg-2/45 px-3 py-2.5 shadow-[0_-1px_0_var(--app-bg-a2)] sm:px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-app-bg-1 px-2 py-1 text-[12px] font-medium text-app-fg-3 shadow-[0_0_0_1px_var(--app-fg-a1)]">
            <ShieldCheck size={13} />
            {toolChipLabel(staging.toolName)}
          </span>
          <Link
            to="/approvals"
            className={cn(
              "inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-app-fg-3",
              "transition-[background-color,color] hover:bg-app-bg-a2 hover:text-app-fg-4",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
            )}
          >
            View all
            <ExternalLink size={12} />
          </Link>
        </div>

        {decided ? (
          <div className="flex min-h-8 items-center gap-2 text-[13px] font-medium text-app-fg-3">
            <Loader2 size={14} className="animate-spin" />
            Resuming…
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <AppButton
              variant="ghost"
              size="sm"
              leading={editing ? ICON_X : ICON_PENCIL}
              disabled={busy}
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? "Done" : "Adjust"}
            </AppButton>
            {showReason ? (
              <>
                <AppButton
                  variant="ghost"
                  size="sm"
                  leading={ICON_BAN}
                  disabled={busy || reasonMissing}
                  onClick={() => decide({ decision: "cancel_run", reason: reason.trim() })}
                >
                  End run
                </AppButton>
                <AppButton
                  variant="destructive"
                  size="sm"
                  leading={ICON_XCIRCLE}
                  disabled={busy || reasonMissing}
                  onClick={() => decide({ decision: "reject", reason: reason.trim() })}
                >
                  Reject
                </AppButton>
              </>
            ) : (
              <AppButton
                variant="ghost"
                size="sm"
                leading={ICON_XCIRCLE}
                disabled={busy}
                onClick={() => setShowReason(true)}
              >
                Reject
              </AppButton>
            )}
            <AppButton
              variant="primary"
              size="sm"
              leading={edited ? ICON_PENCIL : ICON_CHECK}
              loading={busy}
              disabled={busy}
              onClick={() =>
                decide(
                  edited
                    ? { decision: "approve", editedInput: draftInput }
                    : { decision: "approve" },
                )
              }
            >
              {approveLabel}
            </AppButton>
          </div>
        )}
      </div>
    </section>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-10 items-center justify-center rounded-xl",
        "text-app-fg-3 transition-[background-color,color,transform]",
        "hover:bg-app-bg-a2 hover:text-app-fg-4 active:scale-[0.96]",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
      )}
    >
      {children}
    </button>
  );
}

function approvalLabel(riskTier: ToolRiskTier, edited: boolean): string {
  if (edited)
    return riskTier === "no_risk" || riskTier === "low" ? "Allow changes" : "Approve changes";
  return riskTier === "no_risk" || riskTier === "low" ? "Allow once" : "Approve";
}

function policyCopy(riskTier: ToolRiskTier): string {
  if (riskTier === "no_risk") {
    return "This integration is set to ask first. This action does not change external data.";
  }
  if (riskTier === "low") {
    return "This integration is set to ask first. Review the target before Alfred reads more context.";
  }
  return "This action can change data outside Alfred. Review the details before it runs.";
}
