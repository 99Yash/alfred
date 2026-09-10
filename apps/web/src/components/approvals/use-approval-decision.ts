import type { SyncedActionStaging } from "@alfred/sync";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { cardTitle } from "./card-spec";
import { formatJson } from "./format";

/** The approve arm, shared by both cards: it may carry an edited input. */
type ApproveDecision = {
  decision: "approve";
  expectedRowVersion: number;
  editedInput?: unknown;
  reason?: never;
};

/**
 * The decision a reviewer records for one staged *write*. Approving may carry
 * an edited input (the fields are always live); rejecting/cancelling carries
 * the revision note sent back to Alfred, which is why `reason` is required
 * here and not optional.
 */
export type WriteDecision =
  | ApproveDecision
  | { decision: "reject"; expectedRowVersion: number; reason: string }
  | { decision: "cancel_run"; expectedRowVersion: number; reason: string };

/**
 * The decision a reviewer records for one parked `system.ask_user` question
 * (ADR-0099). Two arms only: send the answers, or dismiss. A dismissal IS the
 * answer, so its `reject` carries no revision note — and it carries no
 * `cancel_run` either, because the question card offers no such button.
 *
 * Both unions are `reject`-on-the-wire and neither needs a mapper. Keeping
 * them separate is what makes a reason-less write rejection uncompilable and a
 * `cancel_run` from a question card uncompilable, including where a generic
 * parameter widens to {@link RecordedDecision}.
 */
export type QuestionDecision = ApproveDecision | { decision: "reject"; expectedRowVersion: number };

/** Anything a reviewer can record against one staged row. */
export type RecordedDecision = WriteDecision | QuestionDecision;

export interface ApprovalDecisionState {
  /** The (possibly edited) tool input the reviewer will approve. */
  draftInput: unknown;
  setDraftInput: (value: unknown) => void;
  /** Whether the "what should Alfred change?" revision note is expanded. */
  showReason: boolean;
  setShowReason: Dispatch<SetStateAction<boolean>>;
  reason: string;
  setReason: (value: string) => void;
  reasonRef: React.RefObject<HTMLTextAreaElement | null>;
  /** A decision is in flight (API call / parent callback). */
  busy: boolean;
  /** The decision landed; the surface shows a "resuming" affordance. */
  decided: boolean;
  setDecided: (value: boolean) => void;
  error: string | null;
  setError: (value: string | null) => void;
  /** The draft differs from the staged proposal — flips button copy to "changes". */
  edited: boolean;
  /** The revision note is empty — gates reject / cancel. */
  reasonMissing: boolean;
  /** Input-aware headline for the card. */
  title: string;
  /** The approve decision for the current edit state (plain vs approve-with-edits). */
  approveDecision: () => ApproveDecision;
  /**
   * Run a decision executor under the shared guard: bails if already busy or
   * decided, toggles `busy`, and surfaces a thrown error (leaving `busy` false).
   * On success `busy`/`decided` are left for the caller — the standalone card
   * unmounts via Replicache, the inline card flips to "resuming".
   */
  run: (execute: () => Promise<void>) => Promise<void>;
}

/**
 * The approval decision state machine, shared by the standalone `ApprovalCard`
 * (the `/approvals` page) and the inline `InlineApprovalCard` (chat). Both
 * surfaces embed this; each keeps only its own chrome and button layout, which
 * legitimately differ (the chat card adds "always allow", a resuming state, and
 * risk-tier labels). Centralizing the state means a change to the decision
 * contract — a new decision, the edited/approve branch, the revision copy —
 * lands in one place instead of being applied to both cards in lockstep.
 */
export function useApprovalDecision(staging: SyncedActionStaging): ApprovalDecisionState {
  const [draftInput, setDraftInput] = useState<unknown>(() => staging.proposedInput);
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Compared BY VALUE, never by reference. Every Replicache poke re-parses the
  // whole pending set (`SYNC_MODEL.actionstaging.scan`), so each pending row
  // gets a fresh object identity on every fire — and something fires without
  // any user action: the approval notification worker stamps `notified_at`
  // and bumps `row_version` five minutes in. A reference compare therefore
  // discarded the draft on a routine poke. That is survivable for a write
  // (the draft held a proposal the user could re-read on screen) and a data
  // loss for a question, whose draft holds content only the user can produce.
  const stagedInput = formatJson(staging.proposedInput);
  const [previousStaging, setPreviousStaging] = useState({
    id: staging.id,
    stagedInput,
  });
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // Re-seed when the staged value changes underneath us (streamed edits, or the
  // same card component being reused for a different row). A render-phase state
  // adjustment, so React discards the queued setState with the render if it
  // bails out — a ref write would leak and desync the tracker.
  if (staging.id !== previousStaging.id || stagedInput !== previousStaging.stagedInput) {
    setPreviousStaging({ id: staging.id, stagedInput });
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
    () => formatJson(draftInput).trim() !== stagedInput.trim(),
    [draftInput, stagedInput],
  );
  const title = useMemo(
    () => cardTitle(staging.toolName, edited ? draftInput : staging.proposedInput),
    [staging.toolName, edited, draftInput, staging.proposedInput],
  );
  const reasonMissing = reason.trim().length === 0;

  const approveDecision = (): ApproveDecision =>
    edited
      ? { decision: "approve", expectedRowVersion: staging.rowVersion, editedInput: draftInput }
      : { decision: "approve", expectedRowVersion: staging.rowVersion };

  const run = async (execute: () => Promise<void>): Promise<void> => {
    if (busy || decided) return;
    setBusy(true);
    setError(null);
    try {
      await execute();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record decision");
      setBusy(false);
    }
  };

  return {
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
  };
}
