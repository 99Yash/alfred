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
  // Lazily allocated: `useRef(new Set())` builds and discards a Set on every
  // render. Pruned to the rows still on screen on each fire, so a long thread
  // does not accumulate an id per approval it ever showed — a row that leaves
  // `pending` never comes back, so dropping it cannot re-chime.
  const notifiedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (preview) return;
    const notified = (notifiedRef.current ??= new Set());
    const fresh = approvals.filter((row) => !notified.has(row.id));
    const live = new Set(approvals.map((row) => row.id));
    for (const id of notified) if (!live.has(id)) notified.delete(id);
    if (fresh.length === 0) return;
    for (const row of fresh) notified.add(row.id);
    const first = fresh[0];
    // A question is not a permission request, so it gets its own chime copy —
    // "Approval needed" over a card asking which recipient to use reads as a
    // warning about an action the user never proposed.
    const lone = fresh.length === 1 ? first : undefined;
    const loneQuestion = lone ? asQuestionStaging(lone) : null;
    callToast({
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
            {/* Neutral over both card kinds: the pending row below may be a
             * question, and "Waiting for approval" reads as a permission
             * prompt the user never asked for. */}
            {recentDecision ? "Resuming after your decision…" : "Waiting for your decision…"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {approvals.map((staging) => {
        // A question is an approval with a different card (ADR-0099): same
        // staged row, same decision route, but the body is an answer sheet and
        // the actions are Continue / Dismiss. A staged input that does not
        // parse falls back to the ordinary card rather than to nothing.
        const question = asQuestionStaging(staging);
        return question ? (
          <InlineQuestionCard
            key={staging.id}
            question={question}
            preview={preview}
            onDecision={() => setRecentDecision(true)}
          />
        ) : (
          <InlineApprovalCard
            key={staging.id}
            staging={staging}
            preview={preview}
            onDecision={() => setRecentDecision(true)}
          />
        );
      })}
    </div>
  );
}

/** The toast a landed decision raises. */
interface DecisionToast {
  tone: "success" | "info";
  message: string;
  description: string;
}

/**
 * Posts one decision for a staged row and lands the card's local state: which
 * decision it was (drives the resolved badge) and the "resuming" affordance.
 * Shared by the write card and the question card, which differ only in the
 * copy they raise — the route, the error wording, and the preview no-op are
 * the same for both.
 */
function useRecordDecision<Decision extends RecordedDecision>({
  staging,
  preview,
  onDecision,
  run,
  setDecided,
  toastFor,
}: {
  staging: SyncedActionStaging;
  preview: boolean | undefined;
  onDecision: () => void;
  run: ApprovalDecisionState["run"];
  setDecided: (value: boolean) => void;
  toastFor: (decision: Decision) => DecisionToast;
}) {
  // Generic over the decision union, so a write card cannot record a
  // reason-less rejection and a question card cannot record a `cancel_run`.
  // The card passes its own union, so each copy builder below covers exactly
  // the kinds its own card raises — and a `never` guard in each proves it.
  const [decisionKind, setDecisionKind] = useState<Decision["decision"] | null>(null);

  const decide = (decision: Decision) => {
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
      const { tone, message, description } = toastFor(decision);
      const recorded = tone === "success" ? toast.success : toast.info;
      recorded({ message, description, position: "top-center" });
    });
  };

  return { decisionKind, decide };
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
  const { decisionKind, decide } = useRecordDecision({
    staging,
    preview,
    onDecision,
    run,
    setDecided,
    toastFor: writeDecisionToast,
  });

  // Open while the decision is pending; auto-collapse the moment it lands,
  // leaving the collapsed trigger row with the resolved badge. Render-phase
  // tracking (no effect) so the collapse lands on the same frame as `decided`.
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

/** The toast copy for a write approval's three decisions. */
function writeDecisionToast(decision: WriteDecision): DecisionToast {
  if (decision.decision === "approve") {
    return {
      tone: "success",
      message: "Approval recorded",
      description: "Alfred is resuming the run.",
    };
  }
  if (decision.decision === "reject") {
    return {
      tone: "info",
      message: "Sent back to Alfred",
      description: "Alfred is resuming the run.",
    };
  }
  if (decision.decision === "cancel_run") {
    return { tone: "info", message: "Run ended", description: "Alfred stopped this run." };
  }
  // A new arm on `WriteDecision` fails to compile here instead of falling
  // through to another decision's copy.
  const unhandled: never = decision;
  return unhandled;
}

/**
 * The toast copy for a question's two decisions. Both arms are `approve` /
 * `reject` on the wire, so the copy — not the wire shape — is what separates
 * "answers sent" from "dismissed".
 */
function questionDecisionToast(decision: QuestionDecision): DecisionToast {
  if (decision.decision === "approve") {
    return {
      tone: "success",
      message: "Answers sent",
      description: "Alfred is continuing the turn.",
    };
  }
  if (decision.decision === "reject") {
    return {
      tone: "info",
      message: "Question dismissed",
      description: "Alfred is continuing without an answer.",
    };
  }
  const unhandled: never = decision;
  return unhandled;
}

/**
 * A parked `system.ask_user` question, inline under the tool trail (ADR-0099).
 *
 * The row is an ordinary staged approval, so this card rides the same decision
 * route and the same Replicache row as a write approval — a reload during the
 * park draws the same open card, and the composer stays disabled the whole
 * time. Only three things differ: the body is an answer sheet instead of a
 * field editor, the panel stays open (a question is the point of the turn, not
 * a detail to fold away), and the actions read Dismiss / Continue.
 *
 * The card owns the chrome only. {@link QuestionSheet} owns the answer sheet,
 * the action row, and the keyboard contract, so the `/approvals` queue's card
 * draws the identical body from the identical component.
 *
 * The answers ride the approval's `editedInput`. Continuing without answering
 * anything sends a plain approval, which the tool reports to the model as
 * `no_answers` rather than as a sheet full of blanks.
 */
function InlineQuestionCard({
  question,
  preview = false,
  onDecision,
}: {
  question: QuestionStaging;
  preview?: boolean | undefined;
  onDecision: () => void;
}) {
  const staging = question.staging;
  const { draftInput, setDraftInput, busy, decided, setDecided, error, approveDecision, run } =
    useApprovalDecision(staging);
  const { decisionKind, decide } = useRecordDecision<QuestionDecision>({
    staging,
    preview,
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
        // A dismissal IS the answer, so it goes on the wire as a plain
        // reason-less rejection — the same shape the route already accepts for
        // a question (ADR-0099). No separate decision kind exists.
        onDismiss={() =>
          void decide({ decision: "reject", expectedRowVersion: staging.rowVersion })
        }
      />
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

/** The trigger's subline once the decision has landed. Write cards only — the
 * question card carries its own subline, whose "reject" reads as a dismissal
 * rather than as a revision note. */
function ResolvedCopy({ kind, edited }: { kind: WriteDecision["decision"]; edited: boolean }) {
  if (kind === "approve") {
    return edited ? "Approved with changes — resuming the run." : "Approved — resuming the run.";
  }
  if (kind === "reject") return "Sent back to Alfred with a revision note.";
  if (kind === "cancel_run") return "Run ended at your request.";
  const unhandled: never = kind;
  return unhandled;
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
