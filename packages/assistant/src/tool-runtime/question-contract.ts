import { askUserAnswerSchema, askUserQuestionSchema } from "@alfred/contracts";
import { z } from "zod";

/**
 * The two fields the question arm reads off a `staging: "question"` call (ADR-0099).
 * Loose: the rest of the input belongs to the tool schema.
 */
export const questionToolInput = z
  .object({
    questions: z.array(askUserQuestionSchema).min(1),
    answers: z.array(askUserAnswerSchema).optional(),
  })
  .loose();

export type QuestionToolInput = z.infer<typeof questionToolInput>;

/** What the model may send. Its `modelInputSchema` must accept this at boot. */
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

/** With the user's answer: `inputSchema` must accept it and `modelInputSchema` must refuse it. */
export const QUESTION_TOOL_PROBE_INPUT = {
  ...QUESTION_TOOL_MODEL_PROBE_INPUT,
  answers: [{ selectedOptions: ["First"], customAnswer: null }],
} satisfies QuestionToolInput;
