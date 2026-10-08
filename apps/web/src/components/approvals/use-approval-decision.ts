import type { SyncedActionStaging } from "@alfred/sync";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { cardTitle } from "./card-spec";
import { formatJson } from "./format";

/** Approve may carry an edited input. */
type ApproveDecision = {
  decision: "approve";
  expectedRowVersion: number;
  editedInput?: unknown;
  reason?: never;
};

/** A decision on a staged write. Reject and cancel need `reason`, the revision note sent to Alfred. */
export type WriteDecision =
  | ApproveDecision
  | { decision: "reject"; expectedRowVersion: number; reason: string }
  | { decision: "cancel_run"; expectedRowVersion: number; reason: string };

/**
 * A decision on a parked `system.ask_user` question (ADR-0099). A dismissal is the
 * answer, so it has no reason, and the card has no `cancel_run`.
 * Separate unions keep a reason-less write reject and a question `cancel_run` uncompilable.
 */
export type QuestionDecision = ApproveDecision | { decision: "reject"; expectedRowVersion: number };

export type RecordedDecision = WriteDecision | QuestionDecision;

export interface ApprovalDecisionState {
  draftInput: unknown;
  setDraftInput: (value: unknown) => void;
  /** Whether the "what should Alfred change?" revision note is expanded. */
  showReason: boolean;
  setShowReason: Dispatch<SetStateAction<boolean>>;
  reason: string;
  setReason: (value: string) => void;
  reasonRef: React.RefObject<HTMLTextAreaElement | null>;
  busy: boolean;
  /** The decision landed; the card shows "resuming". */
  decided: boolean;
  setDecided: (value: boolean) => void;
  error: string | null;
  setError: (value: string | null) => void;
  /** The draft differs from the proposal; button copy says "changes". */
  edited: boolean;
  /** Gates reject and cancel. */
  reasonMissing: boolean;
  title: string;
  approveDecision: () => ApproveDecision;
  /**
   * Run a decision once: skips if busy or decided, and shows a thrown error.
   * On success the caller owns `busy`/`decided`.
   */
  run: (execute: () => Promise<void>) => Promise<void>;
}

/** Decision state shared by every approval card; each card keeps only its own chrome. */
export function useApprovalDecision(staging: SyncedActionStaging): ApprovalDecisionState {
  const [draftInput, setDraftInput] = useState<unknown>(() => staging.proposedInput);
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Compare by value. Every Replicache poke re-parses the rows into new objects,
  // and pokes happen with no user action (the notification worker bumps `row_version`).
  // A reference compare would drop a question draft only the user can recreate.
  const stagedInput = formatJson(staging.proposedInput);

  const [previousStaging, setPreviousStaging] = useState({
    id: staging.id,
    stagedInput,
  });

  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // Re-seed when the staged value or row changes. Render-phase state, not a ref,
  // so a bailed-out render discards it too.
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
