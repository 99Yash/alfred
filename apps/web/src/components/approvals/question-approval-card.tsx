import { Link } from "@tanstack/react-router";
import { useApprovalDecision, type QuestionDecision } from "./use-approval-decision";
import { Workflow } from "lucide-react";
import { AppCard } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { formatTimestamp, shortId, triggerLabel } from "./format";
import { QuestionSheet } from "./question-sheet";
import type { QuestionStaging } from "./ask-user";

/**
 * A parked `system.ask_user` question in the `/approvals` queue and in a
 * workflow's Approvals tab (ADR-0099).
 *
 * The sibling of the chat tray's inline question card: same staged row, same
 * decision route, and the same {@link QuestionSheet} body, so an answer sheet
 * cannot drift between the two surfaces. Only the chrome differs — this card
 * leads with the queue's row metadata (workflow, trigger, run, time), because
 * a queue reader has no transcript above the card to say where the question
 * came from.
 *
 * The headline states the question count and no tool chip appears. The chip
 * would read "Ask you a question" directly under a headline saying the same
 * thing, and the tool name is not what a reader of this card needs.
 */
export function QuestionApprovalCard({
  question,
  onDecide,
}: {
  question: QuestionStaging;
  /** Resolves when the decision is recorded; throws with a message on failure. */
  onDecide: (decision: QuestionDecision) => Promise<void>;
}) {
  const staging = question.staging;
  const { draftInput, setDraftInput, busy, decided, error, approveDecision, run } =
    useApprovalDecision(staging);

  // On success the row leaves the pending queue and Replicache removes the
  // card; `run` leaves `busy` set and no local cleanup is needed.
  const decide = (decision: QuestionDecision) => void run(() => onDecide(decision));
  const count = question.input.questions.length;

  return (
    <AppCard padded={false}>
      <div className="p-5 pb-4">
        <div className="flex items-start gap-3">
          <img
            src="/images/logo/alfred-logo.svg"
            alt=""
            className="size-8 shrink-0 rounded-[9px]"
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] leading-snug font-medium text-pretty text-app-fg-4">
              {count === 1 ? "Alfred has a question" : `Alfred has ${count} questions`}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-app-fg-3">
              <Link
                to="/workflows/$workflow"
                params={{ workflow: staging.workflowSlug }}
                className={cn(
                  "inline-flex items-center gap-1 rounded font-medium transition-colors hover:text-app-fg-4",
                  "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
                )}
              >
                <Workflow size={12} />
                {staging.workflowName}
              </Link>
              <span className="text-app-fg-2">·</span>
              <span>{triggerLabel(staging.trigger)}</span>
              <span className="text-app-fg-2">·</span>
              <span className="font-mono">{shortId(staging.runId)}</span>
              <span className="text-app-fg-2">·</span>
              <span className="tabular-nums">{formatTimestamp(staging.createdAt)}</span>
            </div>
          </div>
        </div>
      </div>

      <QuestionSheet
        question={question}
        draftInput={draftInput}
        onDraftChange={setDraftInput}
        busy={busy}
        decided={decided}
        error={error}
        idPrefix={`app-question-${staging.id}`}
        settledLabel="Continuing…"
        className="p-5"
        onContinue={() => decide(approveDecision())}
        // A dismissal IS the answer, so it goes on the wire as a plain
        // reason-less rejection — the shape the route accepts for a question.
        onDismiss={() => decide({ decision: "reject", expectedRowVersion: staging.rowVersion })}
      />
    </AppCard>
  );
}
