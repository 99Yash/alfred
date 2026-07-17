import type { ToolRiskTier } from "@alfred/contracts";
import { isLoadableIntegrationSlug } from "@alfred/contracts";
import type { SyncedActionStaging } from "@alfred/sync";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Ban,
  Check,
  ExternalLink,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalDecision } from "~/components/approvals/approval-card";
import { cardTitle, toolChipLabel } from "~/components/approvals/card-spec";
import { formatJson, formatTimestamp } from "~/components/approvals/format";
import { ApprovalInputEditor } from "~/components/approvals/input-editor";
import { RiskPill } from "~/components/approvals/risk-pill";
import { ToolIcon } from "~/components/approvals/tool-icon";
import { AppButton, AppTextarea } from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { getIntegrationProvider } from "~/lib/integrations/integrations";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import { callToast, toast } from "~/lib/toast";
import { cn } from "~/lib/utils";

// Hoisted so the `leading` props below don't allocate a fresh element per render.
const ICON_X = <X size={13} />;
const ICON_REVISE = <RefreshCw size={13} />;
const ICON_BAN = <Ban size={13} />;
const ICON_CHECK = <Check size={13} />;
const ICON_PENCIL = <Pencil size={13} />;
const ICON_SHIELD = <ShieldCheck size={13} />;

/**
 * Renders the pending approvals for a run inline in the transcript, right below
 * the tool trail whose action they gate. One card per staged action, stacked in
 * the order they were passed (the conversation orders them by tool position, so
 * each card sits under the call it belongs to). Replaces the old detached
 * step-through tray: the decision now lives where the action appears, not in a
 * separate bar above the composer.
 *
 * The approval "chime" (toast + sound) fires once here for the batch — a stack
 * of cards must not overlap N sounds — while every other decision detail lives
 * in {@link InlineApprovalCard}.
 */
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
  const [recentDecision, setRecentDecision] = useState(false);
  const [previousRunId, setPreviousRunId] = useState(runId);
  if (runId !== previousRunId) {
    setPreviousRunId(runId);
    setRecentDecision(false);
  }

  // Chime once per freshly-arrived batch of approvals. A per-card effect would
  // fire N toasts and stack N overlapping sounds when several actions gate at
  // once; centralizing it here keeps a single "review this" signal.
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (preview) return;
    const fresh = approvals.filter((row) => !notifiedRef.current.has(row.id));
    if (fresh.length === 0) return;
    for (const row of fresh) notifiedRef.current.add(row.id);
    const first = fresh[0];
    callToast({
      message: "Approval needed",
      description:
        fresh.length === 1 && first
          ? cardTitle(first.toolName, first.proposedInput)
          : `${fresh.length} actions need your review`,
      icon: <ShieldCheck size={14} className="text-app-purple-3" />,
    });
    const audio = new Audio("/sounds/run-finished.mp3");
    audio.volume = 0.42;
    void audio.play().catch(() => {
      // Browsers can block audio until the page has user activation. The inline
      // card remains the source of truth when that happens.
    });
  }, [approvals, preview]);

  if (!runId) return null;

  if (approvals.length === 0) {
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
    <div className="flex flex-col gap-2">
      {approvals.map((staging) => (
        <InlineApprovalCard
          key={staging.id}
          staging={staging}
          preview={preview}
          onDecision={() => setRecentDecision(true)}
        />
      ))}
    </div>
  );
}

function InlineApprovalCard({
  staging,
  preview = false,
  onDecision,
}: {
  staging: SyncedActionStaging;
  preview?: boolean;
  onDecision: () => void;
}) {
  const [draftInput, setDraftInput] = useState<unknown>(() => staging.proposedInput);
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previousStaging, setPreviousStaging] = useState({
    id: staging.id,
    proposedInput: staging.proposedInput,
  });
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const { setIntegrationMode } = useActionPolicy();

  // Re-seed when the staged value changes underneath us (streamed edits, or the
  // same card component being reused for a different row). A render-phase state
  // adjustment, so React discards the queued setState with the render if it
  // bails out — a ref write would leak and desync the tracker.
  if (
    staging.id !== previousStaging.id ||
    staging.proposedInput !== previousStaging.proposedInput
  ) {
    setPreviousStaging({ id: staging.id, proposedInput: staging.proposedInput });
    setDraftInput(staging.proposedInput);
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
  const title = useMemo(
    () => cardTitle(staging.toolName, edited ? draftInput : staging.proposedInput),
    [staging.toolName, edited, draftInput, staging.proposedInput],
  );
  const reasonMissing = reason.trim().length === 0;

  const decide = async (decision: ApprovalDecision, alwaysAllowName?: string) => {
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
      onDecision();
      const recorded = decision.decision === "approve" ? toast.success : toast.info;
      recorded({
        message: alwaysAllowName
          ? `Always allowing ${alwaysAllowName}`
          : decision.decision === "approve"
            ? "Approval recorded"
            : decision.decision === "reject"
              ? "Sent back to Alfred"
              : "Run ended",
        description: alwaysAllowName
          ? `Alfred won't ask before ${alwaysAllowName} actions like this. Change it in Settings.`
          : decision.decision === "cancel_run"
            ? "Alfred stopped this run."
            : "Alfred is resuming the run.",
        position: "top-center",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record decision");
      setBusy(false);
    }
  };

  // "Always allow" flips the whole integration to autonomy, then approves this
  // call (the staged row's requiresApproval is frozen at dispatch, so the policy
  // flip alone won't release it). Hidden on high-tier cards: high-tier actions
  // confirm even under autonomy (the one-way floor), so the button would flip
  // the policy yet keep prompting — misleading. System tools never gate and
  // aren't loadable, so they're excluded too.
  const canAlwaysAllow =
    staging.riskTier !== "high" && isLoadableIntegrationSlug(staging.integration);
  const integrationName = getIntegrationProvider(staging.integration)?.name ?? staging.integration;

  const allowAlways = async () => {
    if (busy || decided || preview) return;
    if (!isLoadableIntegrationSlug(staging.integration)) return;
    setError(null);
    try {
      await setIntegrationMode(staging.integration, "autonomy");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update policy");
      return;
    }
    await decide(
      edited ? { decision: "approve", editedInput: draftInput } : { decision: "approve" },
      integrationName,
    );
  };

  const approveLabel = approvalLabel(staging.riskTier, edited);
  const policy = policyCopy(staging.riskTier);

  return (
    <section
      aria-label="Approval required"
      className={cn("app-frost-overlay animate-chat-in overflow-hidden rounded-2xl")}
    >
      <div className="flex items-start gap-3 p-3 sm:px-4">
        <ToolIcon integration={staging.integration} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 truncate text-[15px] leading-6 font-medium text-app-fg-4">
              {title}
            </p>
            <RiskPill riskTier={staging.riskTier} />
          </div>
          <p className="mt-1 max-w-[42rem] text-[12px] leading-5 text-pretty text-app-fg-3">
            {policy}
          </p>
        </div>
      </div>

      <div className="px-3 pb-3 sm:px-4">
        {/* Fields are always live — no read-only/Adjust step. Edit in place, then
         * the primary button reads "Approve changes". */}
        <ApprovalInputEditor
          toolName={staging.toolName}
          value={draftInput}
          onChange={setDraftInput}
          disabled={busy || decided}
          idPrefix={`chat-approval-input-${staging.id}`}
        />

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
              What should Alfred change?
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
            {/* Revise sends the action back to Alfred with a note — the run stays
             * alive and Alfred tries again. Distinct from End run, which stops. */}
            <AppButton
              variant="ghost"
              size="sm"
              leading={showReason ? ICON_X : ICON_REVISE}
              disabled={busy}
              onClick={() => {
                setShowReason((v) => !v);
                setError(null);
              }}
            >
              {showReason ? "Cancel" : "Revise"}
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
                  variant="primary"
                  size="sm"
                  leading={ICON_REVISE}
                  loading={busy}
                  disabled={busy || reasonMissing}
                  onClick={() => decide({ decision: "reject", reason: reason.trim() })}
                >
                  Send revision
                </AppButton>
              </>
            ) : (
              <>
                {canAlwaysAllow ? (
                  <AppButton
                    variant="ghost"
                    size="sm"
                    leading={ICON_SHIELD}
                    disabled={busy}
                    onClick={allowAlways}
                  >
                    Always allow {integrationName}
                  </AppButton>
                ) : null}
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
              </>
            )}
          </div>
        )}
      </div>
    </section>
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
