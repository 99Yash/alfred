import { askUserAnswerSchema, askUserQuestionSchema } from "@alfred/contracts";
import { z } from "zod";

/**
 * The shape every `staging: "question"` tool must accept, because the
 * dispatcher's question arm reads `questions` and `answers` off the call itself
 * (ADR-0099). It lives at the tool-runtime boundary for the same reason
 * `joinToolInput` does: two owners must agree on it and must not drift. The
 * registry proves at boot that each question tool accepts
 * {@link QUESTION_TOOL_PROBE_INPUT} and that the parsed value satisfies this
 * shape; the dispatcher PARSES with it instead of casting a name-matched input.
 *
 * Loose on purpose. The full input (`context`, descriptions, limits) is the
 * tool schema's business; this contract names only the two fields the dispatch
 * arm branches on: the question list it echoes back on dismissal or expiry, and
 * the answer list the model must never send on a fresh call.
 */
export const questionToolInput = z
  .object({
    questions: z.array(askUserQuestionSchema).min(1),
    answers: z.array(askUserAnswerSchema).optional(),
  })
  .loose();

export type QuestionToolInput = z.infer<typeof questionToolInput>;

/**
 * One question, with no answer: what the MODEL is allowed to send. The boot
 * proof feeds this to the declaring tool's `modelInputSchema`, so a tool that
 * leaves the model no way to ask a question fails at boot.
 */
export const QUESTION_TOOL_MODEL_PROBE_INPUT = {
  questions: [
    {
      question: "Which option should Alfred take?",
      header: "Probe",
      options: [
        { label: "First", description: "The first probe option." },
        { label: "Second", description: "The second probe option." },
      ],
      multiSelect: false,
    },
  ],
} satisfies QuestionToolInput;

/**
 * The same question with the user's answer on it. The boot proof feeds this to
 * the declaring tool's `inputSchema`, so a schema that accepts a question but
 * refuses the answer the decision route writes back fails at boot, not at the
 * first resume. It feeds it to `modelInputSchema` too, which must REFUSE it:
 * the model may never write the user's half (ADR-0099).
 */
export const QUESTION_TOOL_PROBE_INPUT = {
  ...QUESTION_TOOL_MODEL_PROBE_INPUT,
  answers: [{ selectedOptions: ["First"], customAnswer: null }],
} satisfies QuestionToolInput;
