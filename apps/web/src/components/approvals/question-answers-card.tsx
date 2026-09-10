import type { AskUserUnansweredReason } from "@alfred/contracts";
import { Check, MessageCircleQuestion, X } from "lucide-react";
import { cn } from "~/lib/utils";
import type { AskUserSummary } from "./ask-user";

/**
 * A settled `system.ask_user` call, read-only, in the transcript (ADR-0099).
 *
 * The question card in the approval tray is gone the moment the row leaves
 * `pending`, so this is what the turn leaves behind: the questions Alfred
 * asked and what the user said back, or why no answer arrived. It renders in
 * the activity trail in place of the ordinary tool row, both while the run
 * finishes and on every later reload.
 */
export function QuestionAnswersCard({
  summary,
  inTrail = false,
}: {
  summary: AskUserSummary;
  /** Inside the auto-animated trail, which owns the enter animation. */
  inTrail?: boolean | undefined;
}) {
  const answered = summary.status === "answered";
  return (
    <section
      aria-label={answered ? "Your answers" : "Question not answered"}
      className={cn(
        "rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_var(--app-bg-a2)]",
        !inTrail && "animate-chat-in",
      )}
    >
      <div className="flex items-center gap-2">
        <MessageCircleQuestion size={14} className="shrink-0 text-app-fg-3" />
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-app-fg-4">
          {answered ? "Your answers" : "No answer"}
        </p>
        <span
          aria-hidden
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded-full",
            answered
              ? "text-app-green-4 shadow-[0_0_0_1px_var(--app-green-2)]"
              : "text-app-fg-3 shadow-[0_0_0_1px_var(--app-fg-a1)]",
          )}
        >
          {answered ? <Check size={10} strokeWidth={3} /> : <X size={10} strokeWidth={3} />}
        </span>
      </div>

      {summary.status === "unanswered" ? (
        <>
          <p className="mt-1.5 text-[12px] leading-5 text-app-fg-3">
            {unansweredCopy(summary.reason)}
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {summary.questions.map((question, index) => (
              <li
                key={`${index}-${question.header}`}
                className="text-[12px] leading-5 text-app-fg-3"
              >
                {question.question}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <dl className="mt-2 flex flex-col gap-2.5">
          {summary.answered.map(({ question, answer }, index) => (
            <div key={`${index}-${question.header}`}>
              <dt className="text-[12px] leading-5 text-app-fg-3">{question.question}</dt>
              <dd className="mt-1 flex flex-wrap items-center gap-1.5">
                {answer.selectedOptions.map((label) => (
                  <span
                    key={label}
                    className="rounded-md bg-app-purple-1 px-1.5 py-0.5 text-[12px] font-medium text-app-fg-4"
                  >
                    {label}
                  </span>
                ))}
                {answer.customAnswer ? (
                  <span className="text-[13px] leading-5 text-app-fg-4">{answer.customAnswer}</span>
                ) : null}
                {answer.selectedOptions.length === 0 && !answer.customAnswer ? (
                  <span className="text-[12px] leading-5 text-app-fg-3 italic">Skipped</span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** Why no answer reached the model. One line, no blame. */
function unansweredCopy(reason: AskUserUnansweredReason): string {
  if (reason === "dismissed") return "You dismissed this question. Alfred continued without it.";
  if (reason === "expired") return "The question expired before an answer arrived.";
  return "You continued without answering.";
}
