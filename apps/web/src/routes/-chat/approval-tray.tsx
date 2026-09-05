import type { IntegrationSlug, PolicyMode, ToolRiskTier } from "@alfred/contracts";
import { isLoadableIntegrationSlug, isWriteRiskTier } from "@alfred/contracts";
import type { SyncedActionStaging } from "@alfred/sync";
import * as Accordion from "@radix-ui/react-accordion";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, use, useId, useState } from "react";
import { cardTitle, toolChipLabel } from "~/components/approvals/card-spec";
import { formatTimestamp } from "~/components/approvals/format";
import { ApprovalInputEditor } from "~/components/approvals/input-editor";
import { RiskChip } from "~/components/approvals/risk-pill";
import { ToolIcon } from "~/components/approvals/tool-icon";
import {
  useApprovalDecision,
  type ApprovalDecision,
} from "~/components/approvals/use-approval-decision";
import { AppButton, AppSwitch, AppTextarea } from "~/components/ui/v2";
import { AppThemeContext } from "~/components/ui/v2/theme";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { getIntegrationPage } from "~/lib/integrations/integrations";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import { callToast, toast } from "~/lib/toast";
import { cn } from "~/lib/utils";

// Hoisted so the `leading` props below don't allocate a fresh element per render.
const ICON_X = <X size={13} />;
const ICON_REVISE = <RefreshCw size={13} />;
const ICON_BAN = <Ban size={13} />;
const ICON_CHECK = <Check size={13} />;
const ICON_PENCIL = <Pencil size={13} />;

/** The single accordion item value — one card holds one expandable panel. */
const PANEL_ITEM = "approval";

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
  /** Styleguide-only: render with all interactions local — no toast, audio, API, or policy writes. */
  preview?: boolean | undefined;
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
          <span className={cn(!recentDecision && "animate-chat-shimmer")}>
            {recentDecision ? "Resuming after your decision…" : "Waiting for approval…"}
          </span>
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
  preview?: boolean | undefined;
  onDecision: () => void;
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
    decided,
    setDecided,
    error,
    setError,
    edited,
    reasonMissing,
    title,
    approveDecision,
    run,
  } = useApprovalDecision(staging);
  const { modeFor, setIntegrationMode } = useActionPolicy();

  // Which decision landed — drives the resolved badge (check = approved,
  // ✕ = sent back / run ended).
  const [decisionKind, setDecisionKind] = useState<ApprovalDecision["decision"] | null>(null);

  // Open while the decision is pending; auto-collapse the moment it lands,
  // leaving the collapsed trigger row with the resolved badge. Render-phase
  // tracking (no effect) so the collapse lands on the same frame as `decided`.
  const [panelValue, setPanelValue] = useState(decided ? "" : PANEL_ITEM);
  const [prevDecided, setPrevDecided] = useState(decided);
  if (prevDecided !== decided) {
    setPrevDecided(decided);
    if (decided) setPanelValue("");
  }

  const decide = (decision: ApprovalDecision) => {
    setDecisionKind(decision.decision);
    if (preview) {
      // Styleguide: land the decision locally so the collapse + badge states
      // are demonstrable without an API.
      setDecided(true);
      return;
    }
    return run(async () => {
      const { data, error: responseError } = await client.api
        .approvals({ stagingId: staging.id })
        .decision.post(decision);
      if (responseError) {
        throw new Error(
          responseErrorMessage(responseError.value, responseError.status, "Approval decision"),
        );
      }
      if (data && "refreshed" in data && data.refreshed) {
        toast.info({
          message: "Review the refreshed contract",
          description:
            "Alfred updated the derived schedule and account details. Approve it again to activate the workflow.",
          position: "top-center",
        });
        return;
      }
      setDecided(true);
      onDecision();
      const recorded = decision.decision === "approve" ? toast.success : toast.info;
      recorded({
        message:
          decision.decision === "approve"
            ? "Approval recorded"
            : decision.decision === "reject"
              ? "Sent back to Alfred"
              : "Run ended",
        description:
          decision.decision === "cancel_run"
            ? "Alfred stopped this run."
            : "Alfred is resuming the run.",
        position: "top-center",
      });
    });
  };

  const approveLabel = approvalLabel(staging.toolName, staging.riskTier, edited);
  const policy = policyCopy(staging.riskTier);
  const approved = decisionKind === "approve";

  return (
    <section
      aria-label="Approval required"
      className={cn("app-frost-overlay animate-chat-in overflow-hidden rounded-2xl")}
    >
      <Accordion.Root type="single" collapsible value={panelValue} onValueChange={setPanelValue}>
        <Accordion.Item value={PANEL_ITEM}>
          <div className="relative">
            <Accordion.Header>
              <Accordion.Trigger
                className={cn(
                  "group/approval flex w-full items-center gap-3 px-3 py-3 text-left outline-none sm:px-4",
                  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-purple-2",
                )}
              >
                <ToolIcon integration={staging.integration} />
                <div className="min-w-0 flex-1">
                  {/* While the Permissions affordance is pinned top-right, cap
                   * the title row so long headlines don't run underneath it. */}
                  <div
                    className={cn(
                      "flex flex-wrap items-center gap-2",
                      !decided && canAlwaysAllow(staging) && "pr-24 sm:pr-28",
                    )}
                  >
                    <p className="min-w-0 truncate text-[15px] leading-6 font-medium text-app-fg-4">
                      {title}
                    </p>
                    <RiskChip riskTier={staging.riskTier} />
                  </div>
                  <p className="mt-0.5 max-w-[42rem] truncate text-[12px] leading-5 text-app-fg-3">
                    {decided ? (
                      decisionKind == null ? null : (
                        <ResolvedCopy kind={decisionKind} edited={edited} />
                      )
                    ) : (
                      policy
                    )}
                  </p>
                </div>
                {decided ? (
                  // Resolved coin — check on approval, ✕ on sent-back / ended.
                  // Slides in from under the edge on hover/open (peek state).
                  <span
                    aria-hidden
                    className={cn(
                      "animate-chat-in -mr-7 grid size-5 shrink-0 place-items-center rounded-full",
                      "bg-linear-to-b from-app-bg-1 transition-[margin] duration-200",
                      "group-hover/app:mr-0 group-focus-visible/app:mr-0 group-data-[state=open]/app:mr-0",
                      approved
                        ? "text-app-green-4 shadow-[0_0_0_1px_var(--app-green-2)] to-app-green-2"
                        : "text-app-red-4 shadow-[0_0_0_1px_var(--app-red-2)] to-app-red-1",
                    )}
                  >
                    {approved ? (
                      <Check size={11} strokeWidth={3} />
                    ) : (
                      <X size={11} strokeWidth={3} />
                    )}
                  </span>
                ) : null}
                <ChevronDown
                  size={14}
                  className={cn(
                    "shrink-0 text-app-fg-2 opacity-0 transition-[opacity,transform] duration-200",
                    "group-hover/app:opacity-100 group-focus-visible/app:opacity-100 group-data-[state=open]/app:opacity-100",
                    "group-data-[state=open]/app:-rotate-180",
                  )}
                />
              </Accordion.Trigger>
            </Accordion.Header>
            {!decided && canAlwaysAllow(staging) ? (
              <PermissionsAffordance
                staging={staging}
                preview={preview}
                modeFor={modeFor}
                onFlip={(autonomy) => {
                  if (!isLoadableIntegrationSlug(staging.integration)) return;
                  setError(null);
                  setIntegrationMode(staging.integration, autonomy ? "autonomy" : "gated").catch(
                    (err: unknown) => {
                      setError(err instanceof Error ? err.message : "Failed to update policy");
                    },
                  );
                }}
              />
            ) : null}
          </div>
          <Accordion.Content className="data-[state=closed]:animate-chat-accordion-up data-[state=open]:animate-chat-accordion-down overflow-hidden">
            <div className="border-t border-app-bg-a2 px-3 pt-3 pb-3 sm:px-4">
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

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
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
                  <div className="flex flex-wrap items-center justify-end gap-2">
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
                          onClick={() =>
                            decide({
                              decision: "cancel_run",
                              expectedRowVersion: staging.rowVersion,
                              reason: reason.trim(),
                            })
                          }
                        >
                          End run
                        </AppButton>
                        <AppButton
                          variant="primary"
                          size="sm"
                          leading={ICON_REVISE}
                          loading={busy}
                          disabled={busy || reasonMissing}
                          onClick={() =>
                            decide({
                              decision: "reject",
                              expectedRowVersion: staging.rowVersion,
                              reason: reason.trim(),
                            })
                          }
                        >
                          Send revision
                        </AppButton>
                      </>
                    ) : (
                      <AppButton
                        variant="primary"
                        size="sm"
                        leading={edited ? ICON_PENCIL : ICON_CHECK}
                        loading={busy}
                        disabled={busy}
                        onClick={() => decide(approveDecision())}
                      >
                        {approveLabel}
                      </AppButton>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Accordion.Content>
        </Accordion.Item>
      </Accordion.Root>
    </section>
  );
}

/**
 * "Always allow {integration}" moved off the action row into a Permissions
 * popover pinned to the collapsed trigger's top-right — the card body keeps
 * only the decision buttons, and the standing policy lives where its scope
 * (the whole integration) lives. Flipping the switch is an optimistic policy
 * write; the staged row is frozen at dispatch, so approving below is still
 * what releases this action — the note says so.
 */
function PermissionsAffordance({
  staging,
  preview,
  modeFor,
  onFlip,
}: {
  staging: SyncedActionStaging;
  preview: boolean | undefined;
  modeFor: (slug: IntegrationSlug) => PolicyMode | null;
  onFlip: (autonomy: boolean) => void;
}) {
  const popoverId = useId();
  const integrationName = getIntegrationPage(staging.integration)?.name ?? staging.integration;
  const alwaysAllowed = modeFor(staging.integration) === "autonomy";

  // The popover portals out of the `.app` subtree, so stamp the resolved theme
  // on the content directly (context still flows through the portal). Same
  // pattern as ApprovalModePicker / AppSelect.
  const themeCtx = use(AppThemeContext);
  const dataTheme =
    themeCtx?.mode === "dark" || themeCtx?.mode === "light" ? themeCtx.mode : undefined;

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-controls={popoverId}
          className={cn(
            "absolute top-2.5 right-3 inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-app-fg-3",
            "app-press transition-[box-shadow,color,background-color] outline-none",
            "hover:bg-app-bg-a2 hover:text-app-fg-4",
            "focus-visible:ring-2 focus-visible:ring-app-purple-2",
          )}
        >
          <ShieldCheck size={12} className="shrink-0" />
          Permissions
          <ChevronDown size={12} className="shrink-0 text-app-fg-2" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          id={popoverId}
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          data-app-theme={dataTheme}
          className={cn(
            "app app-frost-overlay z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-hidden rounded-2xl p-3",
            "app-fade-in outline-none",
          )}
        >
          <p className="text-[11px] font-medium tracking-tight text-app-fg-2">
            Default permissions
          </p>
          <div className="flex items-start gap-3">
            <AppSwitch
              id={`permissions-always-${staging.id}`}
              checked={alwaysAllowed}
              onCheckedChange={(checked) => {
                if (!preview) void onFlip(checked === true);
              }}
              className="mt-0.5 shrink-0"
            />
            <div className="min-w-0">
              <label
                htmlFor={`permissions-always-${staging.id}`}
                className="block text-[13px] leading-5 font-medium text-app-fg-4"
              >
                Always allow {integrationName}
              </label>
              <p className="mt-0.5 text-[11.5px] leading-snug text-app-fg-2">
                {alwaysAllowed
                  ? `Alfred acts without asking for ${integrationName} actions like this.`
                  : `Alfred asks before every ${integrationName} action.`}
              </p>
              {!alwaysAllowed ? (
                <p className="mt-1.5 text-[11.5px] leading-snug text-app-fg-2">
                  Applies from Alfred's next action — this one still needs your approval below.
                </p>
              ) : null}
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** The trigger's subline once the decision has landed. */
function ResolvedCopy({ kind, edited }: { kind: ApprovalDecision["decision"]; edited: boolean }) {
  if (kind === "approve") {
    return edited ? "Approved with changes — resuming the run." : "Approved — resuming the run.";
  }
  if (kind === "reject") return "Sent back to Alfred with a revision note.";
  return "Run ended at your request.";
}

/** "Always allow" is only offerable where it can actually take effect: high-tier
 * actions confirm even under autonomy (the one-way floor), so the switch would
 * flip the policy yet keep prompting — misleading. System tools never gate and
 * aren't loadable, so they're excluded too. */
function canAlwaysAllow(staging: SyncedActionStaging): boolean {
  return staging.riskTier !== "high" && isLoadableIntegrationSlug(staging.integration);
}

function approvalLabel(toolName: string, riskTier: ToolRiskTier, edited: boolean): string {
  if (edited && toolName === "system.activate_workflow") return "Review changes";
  if (edited) return isWriteRiskTier(riskTier) ? "Approve changes" : "Allow changes";
  return isWriteRiskTier(riskTier) ? "Approve" : "Allow once";
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
