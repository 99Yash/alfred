import type { IntegrationSlug, PolicyMode, ToolRiskTier } from "@alfred/contracts";
import { isLoadableIntegrationSlug, isWriteRiskTier } from "@alfred/contracts";
import type { SyncedActionStaging } from "@alfred/sync";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowDown,
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Eye,
  MessageCircleQuestion,
  Pencil,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useImperativeHandle, useRef, use, useId, useState } from "react";
import { asQuestionStaging, type QuestionStaging } from "~/components/approvals/ask-user";
import { approveVerb, cardTitle } from "~/components/approvals/card-spec";
import { formatTimestamp } from "~/components/approvals/format";
import { ApprovalInputEditor, ApprovalInputFacts } from "~/components/approvals/input-editor";
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
import { Kbd } from "~/components/ui/kbd";
import { AppThemeContext } from "~/components/ui/v2/theme";
import { responseErrorMessage } from "~/lib/api-error";
import type { StreamingMessage } from "~/lib/chat/chat-stream-state";
import { client } from "~/lib/eden";
import { getIntegrationPage } from "~/lib/integrations/integrations";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import { callToast, toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { usePrefersReducedMotion, type LiveTransition } from "./motion";

// Hoisted so `leading` props do not allocate per render.
const ICON_X = <X size={13} />;

const ICON_REVISE = <RefreshCw size={13} />;

const ICON_BAN = <Ban size={13} />;

const ICON_CHECK = <Check size={13} />;

const ICON_PENCIL = <Pencil size={13} />;

const ICON_EYE = <Eye size={13} />;

/** The house curve (`app-card-in`, the chat keyframes). */
const DOCK_EASE = [0.22, 1, 0.36, 1] as const;

/** The done row stays this long after a decision, so the user sees the result. */
const DONE_HOLD_MS = 900;

/** The check coin's pop, before the hold starts. */
const COIN_POP_MS = 260;

/** What the composer and the dock's own ⌘↵ call: the current card's primary action. */
export interface ApprovalDockHandle {
  approve: () => void;
}

/**
 * The actions a gated run waits on, docked above the composer. One card shows at a time, with a
 * "1 of 2" pager when more wait. The action row stays in view, and only the details scroll.
 * After a decision the card collapses to a done row, holds, and the dock sinks.
 * The chime (toast and sound) fires here once per batch, so stacked cards do not play N sounds.
 */
export function ChatApprovalDock({
  runId,
  approvals,
  preview = false,
  ref,
}: {
  runId: string | undefined;
  /** Pending rows for the run, in tool-trail order. */
  approvals: readonly SyncedActionStaging[];
  /** Styleguide only: no toast, audio, API, or policy writes. */
  preview?: boolean | undefined;
  ref?: React.Ref<ApprovalDockHandle> | undefined;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  // +1 or -1: the pager direction, for the content shift.
  const [direction, setDirection] = useState(1);

  // A decided card stays on screen for the done row, also after its row leaves `pending`.
  const [settled, setSettled] = useState<SyncedActionStaging | null>(null);
  const [previousRunId, setPreviousRunId] = useState(runId);

  // A new run starts fresh. A run that ends (End run, or the turn finishes) keeps its done row.
  if (runId !== previousRunId) {
    setPreviousRunId(runId);

    if (runId !== undefined) {
      setSettled(null);
      setIndex(0);
    }
  }

  useEffect(() => {
    if (!settled) return;
    const timer = window.setTimeout(() => setSettled(null), COIN_POP_MS + DONE_HOLD_MS);

    return () => window.clearTimeout(timer);
  }, [settled]);

  const lastIndex = Math.max(approvals.length - 1, 0);
  const shownIndex = Math.min(index, lastIndex);
  const current = settled ?? approvals[shownIndex] ?? null;

  // The current card registers its primary action here, for ⌘↵.
  const primaryRef = useRef<(() => void) | null>(null);

  useImperativeHandle(ref, () => ({ approve: () => primaryRef.current?.() }), []);

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
    const chimes = (chimesRef.current ??= new Map<string, string | number | null>());
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

  const page = (step: 1 | -1) => {
    setDirection(step);
    setIndex(Math.min(Math.max(shownIndex + step, 0), lastIndex));
  };

  const dockTransition: LiveTransition = reduceMotion
    ? { duration: 0.12, ease: "linear", reduceMotion }
    : { duration: 0.28, ease: DOCK_EASE, reduceMotion };

  const exitTransition: LiveTransition = reduceMotion
    ? { duration: 0.12, ease: "linear", reduceMotion }
    : { duration: 0.2, ease: DOCK_EASE, reduceMotion };

  const pageTransition: LiveTransition = reduceMotion
    ? { duration: 0.12, ease: "linear", reduceMotion }
    : { duration: 0.16, ease: DOCK_EASE, reduceMotion };

  // A pending card counts in the pager. A settled card that left `pending` does not.
  const total = approvals.length;
  const position = settled ? approvals.findIndex((row) => row.id === settled.id) : shownIndex;

  const pager =
    total > 1 && position >= 0 && !settled ? (
      <Pager position={position} total={total} onPage={page} />
    ) : null;

  const question = current ? asQuestionStaging(current) : null;

  return (
    // `initial={false}`: a thread that opens with an approval pending shows the dock in place.
    <AnimatePresence initial={false}>
      {current && (runId !== undefined || settled) ? (
        <m.section
          key="approval-dock"
          aria-label={question ? "Question from Alfred" : "Approval required"}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: "100%" }}
          animate={{ opacity: 1, y: 0, transition: dockTransition }}
          exit={
            reduceMotion
              ? { opacity: 0, transition: exitTransition }
              : { opacity: 0, y: "100%", transition: exitTransition }
          }
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.defaultPrevented) return;
            e.preventDefault();
            primaryRef.current?.();
          }}
          className={cn(
            // Tucked: the queue tray or the composer overlaps the bottom edge, as the queue tray does.
            "relative z-0 mx-3 -mb-5 flex max-h-[min(50vh,32rem)] flex-col overflow-hidden rounded-t-[20px] pb-5",
            "border border-b-0 border-app-fg-a1/30 bg-app-bg-2/90 backdrop-blur-md",
            "shadow-[0_-1px_12px_rgba(0,0,0,0.05)]",
          )}
        >
          <m.div
            key={current.id}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: direction * 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={pageTransition}
            className="flex min-h-0 flex-1 flex-col"
          >
            {question ? (
              <DockQuestionCard
                question={question}
                preview={preview}
                pager={pager}
                primaryRef={primaryRef}
                onDecisionStart={() => dismissChime(current.id)}
                onDecision={() => setSettled(current)}
              />
            ) : (
              <DockApprovalCard
                staging={current}
                preview={preview}
                pager={pager}
                primaryRef={primaryRef}
                onDecisionStart={() => dismissChime(current.id)}
                onDecision={() => setSettled(current)}
              />
            )}
          </m.div>
        </m.section>
      ) : null}
    </AnimatePresence>
  );
}

function Pager({
  position,
  total,
  onPage,
}: {
  position: number;
  total: number;
  onPage: (step: 1 | -1) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`Approval ${position + 1} of ${total}`}
      className="flex shrink-0 items-center gap-0.5 text-[12px] font-medium text-app-fg-3 tabular-nums"
    >
      <PagerButton label="Previous approval" disabled={position === 0} onClick={() => onPage(-1)}>
        <ChevronLeft size={14} />
      </PagerButton>
      <span aria-hidden className="px-0.5">
        {position + 1} of {total}
      </span>
      <PagerButton
        label="Next approval"
        disabled={position === total - 1}
        onClick={() => onPage(1)}
      >
        <ChevronRight size={14} />
      </PagerButton>
    </div>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "app-press app-focus inline-flex size-6 items-center justify-center rounded-md text-app-fg-2",
        "transition-colors duration-150 hover:bg-app-bg-a2 hover:text-app-fg-4",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
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
      onDecision();

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

      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Eden treaty `data` is the server's JSON typed by its route, not parsed here; an empty body or a skewed deploy can leave it null.
      if (data?.status === "restaged") {
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

interface DockCardProps {
  preview: boolean | undefined;
  /** The "1 of 2" control, or `null` for a lone card. */
  pager: React.ReactNode;
  /** Set to the card's primary action while it can run, for ⌘↵. */
  primaryRef: React.RefObject<(() => void) | null>;
  onDecisionStart: () => void;
  onDecision: () => void;
}

function DockApprovalCard({
  staging,
  preview,
  pager,
  primaryRef,
  onDecisionStart,
  onDecision,
}: DockCardProps & { staging: SyncedActionStaging }) {
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
  // The facts list by default; Edit swaps in the field editor.
  const [editing, setEditing] = useState(false);

  const { decisionKind, decide } = useRecordDecision({
    staging,
    preview,
    onDecisionStart,
    onDecision,
    run,
    setDecided,
    toastFor: writeDecisionToast,
  });

  const approve = () => void decide(approveDecision());

  // ⌘↵ approves only while the Approve button could: not mid-request, not decided, not in Revise.
  useEffect(() => {
    if (busy || decided || showReason) return;
    primaryRef.current = approve;

    return () => {
      primaryRef.current = null;
    };
  });

  const approveLabel = approvalLabel(staging.toolName, staging.riskTier, edited);
  const approved = decisionKind === "approve";

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 px-3 pt-3 pb-2 sm:px-4">
        <ToolIcon integration={staging.integration} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="min-w-0 truncate text-[14px] leading-5 font-semibold text-app-fg-4">
              {title}
            </p>
            <RiskChip riskTier={staging.riskTier} />
          </div>
          <p className="mt-0.5 truncate text-[12px] leading-[18px] text-app-fg-3">
            {decided && decisionKind !== null ? (
              <ResolvedCopy kind={decisionKind} edited={edited} />
            ) : (
              policyCopy(staging.riskTier)
            )}
          </p>
        </div>
        {decided ? (
          // Resolved coin: check on approve, ✕ on sent back or ended.
          <span
            aria-hidden
            className={cn(
              "animate-check-pop grid size-5 shrink-0 place-items-center rounded-full",
              "bg-linear-to-b from-app-bg-1",
              approved
                ? "to-app-green-2 text-app-green-4 shadow-[0_0_0_1px_var(--app-green-2)]"
                : "to-app-red-1 text-app-red-4 shadow-[0_0_0_1px_var(--app-red-2)]",
            )}
          >
            {approved ? <Check size={11} strokeWidth={3} /> : <X size={11} strokeWidth={3} />}
          </span>
        ) : (
          <>
            {pager}
            {canAlwaysAllow(staging) ? (
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
          </>
        )}
      </div>

      {/* Collapses to the done row on a decision: grid rows 1fr → 0fr. */}
      <div
        className={cn(
          "grid min-h-0 flex-1 transition-[grid-template-rows] duration-220 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          decided ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <div className="flex min-h-0 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-1 sm:px-4">
            {editing ? (
              <ApprovalInputEditor
                toolName={staging.toolName}
                value={draftInput}
                onChange={setDraftInput}
                disabled={busy || decided}
                idPrefix={`chat-approval-input-${staging.id}`}
              />
            ) : (
              <ApprovalInputFacts toolName={staging.toolName} value={draftInput} />
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

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 pt-2 sm:px-4">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {/* Revise sends the action back with a note and the run continues. End run stops it. */}
              <AppButton
                variant="ghost"
                size="sm"
                leading={showReason ? ICON_X : ICON_REVISE}
                disabled={busy || decided}
                onClick={() => {
                  setShowReason((v) => !v);
                  setError(null);
                }}
              >
                {showReason ? "Cancel" : "Revise"}
              </AppButton>
              {showReason ? null : (
                <AppButton
                  variant="ghost"
                  size="sm"
                  leading={editing ? ICON_EYE : ICON_PENCIL}
                  disabled={busy || decided}
                  onClick={() => setEditing((v) => !v)}
                >
                  {editing ? "Done" : "Edit"}
                </AppButton>
              )}
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

            <div className="flex flex-wrap items-center justify-end gap-2">
              {showReason ? (
                <>
                  <AppButton
                    variant="ghost"
                    size="sm"
                    leading={ICON_BAN}
                    disabled={busy || decided || reasonMissing}
                    onClick={() =>
                      void decide({
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
                    disabled={busy || decided || reasonMissing}
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
                </>
              ) : (
                <>
                  <Kbd className="hidden border-app-fg-a1/40 bg-app-bg-1 text-app-fg-3 sm:inline-flex">
                    ⌘↵
                  </Kbd>
                  <AppButton
                    variant="primary"
                    size="sm"
                    leading={edited ? ICON_PENCIL : ICON_CHECK}
                    loading={busy}
                    disabled={busy || decided}
                    onClick={approve}
                  >
                    {approveLabel}
                  </AppButton>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** Toast for a run-ending write decision. Approve and reject resume the run, so no toast. */
function writeDecisionToast(decision: WriteDecision): DecisionToast | null {
  switch (decision.decision) {
    case "approve":
    case "reject":
      return null;
    case "cancel_run":
      return { tone: "info", message: "Run ended", description: "Alfred stopped this run." };
    default: {
      // A new `WriteDecision` arm fails to compile here.
      const unhandled: never = decision;

      return unhandled;
    }
  }
}

/**
 * Both question decisions continue the turn, so no toast.
 * Kept so a future run-ending decision fails to compile here.
 */
function questionDecisionToast(decision: QuestionDecision): DecisionToast | null {
  switch (decision.decision) {
    case "approve":
    case "reject":
      return null;
    default: {
      const unhandled: never = decision;

      return unhandled;
    }
  }
}

/**
 * A parked `system.ask_user` question (ADR-0099). Same staged row and route as a write approval.
 * {@link QuestionSheet} owns the sheet and its actions, so the `/approvals` card draws the same body.
 * Continue with no answers sends a plain approval, reported to the model as `no_answers`.
 */
function DockQuestionCard({
  question,
  preview,
  pager,
  primaryRef,
  onDecisionStart,
  onDecision,
}: DockCardProps & { question: QuestionStaging }) {
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

  const submitAnswers = () => void decide(approveDecision());

  // ⌘↵ sends the answers, as the sheet's Continue does.
  useEffect(() => {
    if (busy || decided) return;
    primaryRef.current = submitAnswers;

    return () => {
      primaryRef.current = null;
    };
  });

  const count = question.input.questions.length;

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 px-3 pt-3 pb-2 sm:px-4">
        <img src="/images/logo/alfred-logo.svg" alt="" className="size-7 shrink-0 rounded-[8px]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] leading-5 font-semibold text-app-fg-4">
            {count === 1 ? "Alfred has a question" : `Alfred has ${count} questions`}
          </p>
          <p className="mt-0.5 truncate text-[12px] leading-[18px] text-app-fg-3">
            {decided
              ? decisionKind === "approve"
                ? "Answers sent. Alfred is continuing."
                : "Dismissed. Alfred is continuing without an answer."
              : "Answer to continue this turn."}
          </p>
        </div>
        {decided ? null : pager}
      </div>

      <div
        className={cn(
          "grid min-h-0 flex-1 transition-[grid-template-rows] duration-220 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          decided ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          <QuestionSheet
            question={question}
            draftInput={draftInput}
            onDraftChange={setDraftInput}
            busy={busy}
            decided={decided}
            error={error}
            idPrefix={`chat-question-${staging.id}`}
            settledLabel="Continuing…"
            onContinue={submitAnswers}
            // A dismissal is a plain reason-less rejection (ADR-0099).
            onDismiss={() =>
              void decide({ decision: "reject", expectedRowVersion: staging.rowVersion })
            }
          />
        </div>
      </div>
    </>
  );
}

/**
 * "Always allow {integration}" in a popover in the card head. The policy write is optimistic.
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
            "inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-app-fg-3",
            "app-focus app-press transition-[box-shadow,color,background-color]",
            "hover:bg-app-bg-a2 hover:text-app-fg-4",
          )}
        >
          <ShieldCheck size={12} className="shrink-0" />
          <span className="hidden sm:inline">Permissions</span>
          <ChevronDown size={12} className="shrink-0 text-app-fg-2" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          id={popoverId}
          side="top"
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
                if (!preview) onFlip(checked === true);
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
                  Applies from Alfred's next action. This one still needs your approval.
                </p>
              ) : null}
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** Head subline after a decision. Write cards only. */
function ResolvedCopy({ kind, edited }: { kind: WriteDecision["decision"]; edited: boolean }) {
  switch (kind) {
    case "approve":
      return edited ? "Approved with changes. Resuming the run." : "Approved. Resuming the run.";
    case "reject":
      return "Sent back to Alfred with a revision note.";
    case "cancel_run":
      return "Run ended at your request.";
    default: {
      const unhandled: never = kind;

      return unhandled;
    }
  }
}

/**
 * Only where it can take effect: high-tier actions confirm even under autonomy.
 * System tools never gate.
 */
function canAlwaysAllow(staging: SyncedActionStaging): boolean {
  return staging.riskTier !== "high" && isLoadableIntegrationSlug(staging.integration);
}

/** The tool's verb ("Create event") when it has one, else the generic label. */
function approvalLabel(
  toolName: SyncedActionStaging["toolName"],
  riskTier: ToolRiskTier,
  edited: boolean,
): string {
  if (edited && toolName === "system.activate_workflow") return "Review changes";

  if (edited) return isWriteRiskTier(riskTier) ? "Approve changes" : "Allow changes";

  return approveVerb(toolName) ?? (isWriteRiskTier(riskTier) ? "Approve" : "Allow once");
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

/**
 * The feed's line where the docked card waits. It shows only while a row is pending, so a
 * reload and a live decision both leave only the tool row behind.
 */
export function ApprovalMarker({ approvals }: { approvals: readonly SyncedActionStaging[] }) {
  const reduceMotion = usePrefersReducedMotion();
  const [first] = approvals;

  if (!first) return null;

  const label =
    approvals.length > 1
      ? `${approvals.length} actions wait for your approval`
      : asQuestionStaging(first)
        ? "Alfred has a question"
        : "Waiting for your approval";

  const fade: LiveTransition = reduceMotion
    ? { duration: 0.12, ease: "linear", reduceMotion }
    : { duration: 0.2, ease: DOCK_EASE, reduceMotion };

  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: fade }}
      exit={{ opacity: 0, transition: fade }}
      className="inline-flex items-center gap-2 self-start rounded-full bg-app-bg-a2 py-1 pr-2.5 pl-1.5 text-[13px] text-app-fg-3"
    >
      <span
        aria-hidden
        className="grid size-[18px] shrink-0 place-items-center rounded-full bg-app-purple-1 text-app-purple-4"
      >
        <ArrowDown size={11} />
      </span>
      <span className="animate-chat-shimmer">{label}</span>
    </m.div>
  );
}

/** Sort approvals in tool-trail order. Ones with no tool card go last, by `createdAt`. */
export function orderApprovalsByTool(
  approvals: readonly SyncedActionStaging[],
  stream: StreamingMessage | null,
): readonly SyncedActionStaging[] {
  if (approvals.length <= 1) return approvals;
  const toolOrder = new Map<string, number>();
  stream?.tools.forEach((tool, i) => toolOrder.set(tool.toolCallId, i));

  return approvals.toSorted((a, b) => {
    const ia = toolOrder.get(a.toolCallId) ?? Number.POSITIVE_INFINITY;
    const ib = toolOrder.get(b.toolCallId) ?? Number.POSITIVE_INFINITY;

    if (ia !== ib) return ia - ib;

    return a.createdAt.localeCompare(b.createdAt);
  });
}
