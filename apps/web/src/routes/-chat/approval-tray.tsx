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
  MessageCircleQuestion,
  Pencil,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, use, useId, useState } from "react";
import { asQuestionStaging, type QuestionStaging } from "~/components/approvals/ask-user";
import { cardTitle, toolChipLabel } from "~/components/approvals/card-spec";
import { formatTimestamp } from "~/components/approvals/format";
import { ApprovalInputEditor } from "~/components/approvals/input-editor";
import { RiskChip } from "~/components/approvals/risk-pill";
import { ToolIcon } from "~/components/approvals/tool-icon";
import { QuestionSheet } from "~/components/approvals/question-sheet";
import {
  useApprovalDecision,
  type ApprovalDecisionState,
  type QuestionDecision,
  type RecordedDecision,
  type WriteDecision,
} from "~/components/approvals/use-approval-decision";
import { AppButton, AppSwitch, AppTextarea } from "~/components/ui/v2";
import { AppThemeContext } from "~/components/ui/v2/theme";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { getIntegrationPage } from "~/lib/integrations/integrations";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import { callToast, toast } from "~/lib/toast";
import { cn } from "~/lib/utils";

// Hoisted so `leading` props do not allocate per render.
const ICON_X = <X size={13} />;

const ICON_REVISE = <RefreshCw size={13} />;

const ICON_BAN = <Ban size={13} />;

const ICON_CHECK = <Check size={13} />;

const ICON_PENCIL = <Pencil size={13} />;

const PANEL_ITEM = "approval";

/**
 * Pending approvals for a run, one card per staged action, under the tool trail they gate.
 * The chime (toast and sound) fires here once per batch, so stacked cards do not play N sounds.
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
  /** Styleguide only: no toast, audio, API, or policy writes. */
  preview?: boolean | undefined;
}) {
  const [recentDecision, setRecentDecision] = useState(false);
  const [previousRunId, setPreviousRunId] = useState(runId);

  if (runId !== previousRunId) {
    setPreviousRunId(runId);
    setRecentDecision(false);
  }

  // Chime once per new batch. Key: the row chimed; value: its toast, or `null` once retired.
  // Deleting a retired key would re-chime the row. Lazy, because `useRef(new Map())` allocates each render.
  // Pruned to on-screen rows; a row that leaves `pending` never returns.
  const chimesRef = useRef<Map<string, string | number | null> | null>(null);

  // Dismiss on the click, not on the server reply. One chime covers its whole batch.
  const dismissChime = (stagingId: string) => {
    const chimes = chimesRef.current;
    const toastId = chimes?.get(stagingId) ?? null;

    if (!chimes || toastId === null) return;

    toast.dismiss(toastId);

    for (const [id, raised] of chimes) if (raised === toastId) chimes.set(id, null);
  };

  useEffect(() => {
    if (preview) return;
    const chimes = (chimesRef.current ??= new Map());
    const fresh = approvals.filter((row) => !chimes.has(row.id));
    const live = new Set(approvals.map((row) => row.id));

    // A decided row (here, on the approvals page, or by expiry) has a stale chime.
    for (const [id, toastId] of chimes) {
      if (live.has(id)) continue;

      if (toastId !== null) toast.dismiss(toastId);
      chimes.delete(id);
    }

    if (fresh.length === 0) return;

    const first = fresh[0];
    // A question gets its own copy: "Approval needed" reads as a warning about an action the user never proposed.
    const lone = fresh.length === 1 ? first : undefined;
    const loneQuestion = lone ? asQuestionStaging(lone) : null;

    const toastId = callToast({
      message: loneQuestion ? "Alfred has a question" : "Approval needed",
      description: loneQuestion
        ? (loneQuestion.input.questions[0]?.question ?? "Answer to continue the turn.")
        : lone
          ? cardTitle(lone.toolName, lone.proposedInput)
          : `${fresh.length} actions need your review`,
      icon: loneQuestion ? (
        <MessageCircleQuestion size={14} className="text-app-purple-3" />
      ) : (
        <ShieldCheck size={14} className="text-app-purple-3" />
      ),
    });

    for (const row of fresh) chimes.set(row.id, toastId);

    const audio = new Audio("/sounds/run-finished.mp3");
    audio.volume = 0.42;
    void audio.play().catch(() => {
      // Browsers can block audio before user activation; the card still shows.
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
            {/* Neutral: the pending row may be a question, not a permission prompt. */}
            {recentDecision ? "Resuming after your decision…" : "Waiting for your decision…"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {approvals.map((staging) => {
        // A question is a staged approval with a different card (ADR-0099). Unparseable input gets the ordinary card.
        const question = asQuestionStaging(staging);

        return question ? (
          <InlineQuestionCard
            key={staging.id}
            question={question}
            preview={preview}
            onDecisionStart={() => dismissChime(staging.id)}
            onDecision={() => setRecentDecision(true)}
          />
        ) : (
          <InlineApprovalCard
            key={staging.id}
            staging={staging}
            preview={preview}
            onDecisionStart={() => dismissChime(staging.id)}
            onDecision={() => setRecentDecision(true)}
          />
        );
      })}
    </div>
  );
}

interface DecisionToast {
  tone: "success" | "info";
  message: string;
  description: string;
}

/**
 * Post one decision and set the card's local state.
 * Shared by the write and question cards. Approve and reject raise no toast: the card shows "Resuming…".
 */
function useRecordDecision<Decision extends RecordedDecision>({
  staging,
  preview,
  onDecisionStart,
  onDecision,
  run,
  setDecided,
  toastFor,
}: {
  staging: SyncedActionStaging;
  preview: boolean | undefined;
  /** Fires on the click, before the API call. */
  onDecisionStart: () => void;
  onDecision: () => void;
  run: ApprovalDecisionState["run"];
  setDecided: (value: boolean) => void;
  toastFor: (decision: Decision) => DecisionToast | null;
}) {
  // Generic so a write card cannot send a reason-less rejection and a question card cannot send `cancel_run`.
  const [decisionKind, setDecisionKind] = useState<Decision["decision"] | null>(null);

  const decide = (decision: Decision) => {
    setDecisionKind(decision.decision);
    onDecisionStart();

    if (preview) {
      // Styleguide: decide locally so the states show without an API.
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
      const pendingToast = toastFor(decision);

      if (pendingToast) {
        const { tone, message, description } = pendingToast;
        const recorded = tone === "success" ? toast.success : toast.info;
        recorded({ message, description, position: "top-center" });
      }
    });
  };

  return { decisionKind, decide };
}

function InlineApprovalCard({
  staging,
  preview = false,
  onDecisionStart,
  onDecision,
}: {
  staging: SyncedActionStaging;
  preview?: boolean | undefined;
  onDecisionStart: () => void;
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

  const { decisionKind, decide } = useRecordDecision({
    staging,
    preview,
    onDecisionStart,
    onDecision,
    run,
    setDecided,
    toastFor: writeDecisionToast,
  });

  // Open while pending; collapse when decided. Set during render so it lands the same frame.
  const [panelValue, setPanelValue] = useState(decided ? "" : PANEL_ITEM);
  const [prevDecided, setPrevDecided] = useState(decided);

  if (prevDecided !== decided) {
    setPrevDecided(decided);

    if (decided) setPanelValue("");
  }

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
                  "app-focus-inset group/approval flex w-full items-center gap-3 p-3 text-left sm:px-4",
                )}
              >
                <ToolIcon integration={staging.integration} />
                <div className="min-w-0 flex-1">
                  {/* Cap the title row so it does not run under the Permissions button. */}
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
                  // Resolved coin: check on approve, ✕ on sent back or ended.
                  <span
                    aria-hidden
                    className={cn(
                      "animate-chat-in -mr-7 grid size-5 shrink-0 place-items-center rounded-full",
                      "bg-linear-to-b from-app-bg-1 transition-[margin] duration-200",
                      "group-hover/app:mr-0 group-focus-visible/app:mr-0 group-data-[state=open]/app:mr-0",
                      approved
                        ? "to-app-green-2 text-app-green-4 shadow-[0_0_0_1px_var(--app-green-2)]"
                        : "to-app-red-1 text-app-red-4 shadow-[0_0_0_1px_var(--app-red-2)]",
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
            <div className="border-t border-app-bg-a2 p-3 sm:px-4">
              {/* Fields are always editable; the button then reads "Approve changes". */}
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
                      "app-focus",
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
                    {/* Revise sends the action back with a note and the run continues. End run stops it. */}
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

/** Toast for a run-ending write decision. Approve and reject resume the run, so no toast. */
function writeDecisionToast(decision: WriteDecision): DecisionToast | null {
  if (decision.decision === "approve") return null;

  if (decision.decision === "reject") return null;

  if (decision.decision === "cancel_run") {
    return { tone: "info", message: "Run ended", description: "Alfred stopped this run." };
  }

  // A new `WriteDecision` arm fails to compile here.
  const unhandled: never = decision;

  return unhandled;
}

/**
 * Both question decisions continue the turn, so no toast.
 * Kept so a future run-ending decision fails to compile here.
 */
function questionDecisionToast(decision: QuestionDecision): DecisionToast | null {
  if (decision.decision === "approve") return null;

  if (decision.decision === "reject") return null;

  const unhandled: never = decision;

  return unhandled;
}

/**
 * A parked `system.ask_user` question (ADR-0099). Same staged row and route as a write approval.
 * The panel stays open, and the actions are Dismiss / Continue.
 * {@link QuestionSheet} owns the sheet, so the `/approvals` card draws the same body.
 * Continue with no answers sends a plain approval, reported to the model as `no_answers`.
 */
function InlineQuestionCard({
  question,
  preview = false,
  onDecisionStart,
  onDecision,
}: {
  question: QuestionStaging;
  preview?: boolean | undefined;
  onDecisionStart: () => void;
  onDecision: () => void;
}) {
  const staging = question.staging;

  const { draftInput, setDraftInput, busy, decided, setDecided, error, approveDecision, run } =
    useApprovalDecision(staging);

  const { decisionKind, decide } = useRecordDecision<QuestionDecision>({
    staging,
    preview,
    onDecisionStart,
    onDecision,
    run,
    setDecided,
    toastFor: questionDecisionToast,
  });

  const count = question.input.questions.length;

  return (
    <section
      aria-label="Question from Alfred"
      className="app-frost-overlay animate-chat-in overflow-hidden rounded-2xl"
    >
      <div className="flex items-center gap-3 p-3 sm:px-4">
        <img src="/images/logo/alfred-logo.svg" alt="" className="size-8 shrink-0 rounded-[9px]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-6 font-medium text-app-fg-4">
            {count === 1 ? "Alfred has a question" : `Alfred has ${count} questions`}
          </p>
          <p className="mt-0.5 truncate text-[12px] leading-5 text-app-fg-3">
            {decided
              ? decisionKind === "approve"
                ? "Answers sent. Alfred is continuing."
                : "Dismissed. Alfred is continuing without an answer."
              : "Answer to continue this turn."}
          </p>
        </div>
      </div>

      <QuestionSheet
        question={question}
        draftInput={draftInput}
        onDraftChange={setDraftInput}
        busy={busy}
        decided={decided}
        error={error}
        idPrefix={`chat-question-${staging.id}`}
        settledLabel="Continuing…"
        onContinue={() => void decide(approveDecision())}
        // A dismissal is a plain reason-less rejection (ADR-0099).
        onDismiss={() =>
          void decide({ decision: "reject", expectedRowVersion: staging.rowVersion })
        }
      />
    </section>
  );
}

/**
 * "Always allow {integration}" in a popover on the trigger. The policy write is optimistic.
 * The staged row is frozen at dispatch, so this action still needs Approve.
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

  // The popover portals out of `.app`, so stamp the theme on the content.
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
            "app-focus app-press transition-[box-shadow,color,background-color]",
            "hover:bg-app-bg-a2 hover:text-app-fg-4",
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

/** Trigger subline after a decision. Write cards only. */
function ResolvedCopy({ kind, edited }: { kind: WriteDecision["decision"]; edited: boolean }) {
  if (kind === "approve") {
    return edited ? "Approved with changes — resuming the run." : "Approved — resuming the run.";
  }

  if (kind === "reject") return "Sent back to Alfred with a revision note.";

  if (kind === "cancel_run") return "Run ended at your request.";
  const unhandled: never = kind;

  return unhandled;
}

/**
 * Only where it can take effect: high-tier actions confirm even under autonomy.
 * System tools never gate.
 */
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
