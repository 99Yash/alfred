import type { SyncedActionStaging } from "@alfred/sync";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { cardTitle } from "./card-spec";
import { formatJson } from "./format";

/**
 * The decision a reviewer records for one staged action. Approving may carry an
 * edited input (the fields are always live); rejecting/cancelling carries the
 * note sent back to Alfred.
 */
export type ApprovalDecision =
  | { decision: "approve"; editedInput?: unknown; reason?: undefined }
  | { decision: "reject"; reason: string }
  | { decision: "cancel_run"; reason: string };

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
  approveDecision: () => ApprovalDecision;
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
  const [previousStaging, setPreviousStaging] = useState({
    id: staging.id,
    proposedInput: staging.proposedInput,
  });
  const reasonRef = useRef<HTMLTextAreaElement>(null);

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

  const approveDecision = (): ApprovalDecision =>
    edited ? { decision: "approve", editedInput: draftInput } : { decision: "approve" };

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
