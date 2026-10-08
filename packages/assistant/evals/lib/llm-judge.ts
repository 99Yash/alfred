import { route } from "@alfred/ai";
import { generateObject, type LanguageModel } from "ai";
import { createScorer } from "evalite";
import { z } from "zod";

/**
 * LLM-as-a-judge scorer (ADR-0055) for subjective checks, like sound reasoning or a natural todo title.
 * The judge picks a letter grade, not a number: models grade 0-100 inconsistently.
 * The default cheap judge is safe only when deterministic scorers carry the proof.
 * `passthrough-honesty` relies on the judge alone, so it pins `route("standard")`.
 * `voice-ai-tells` pins `route("cheap")` so its grader stays off the OpenAI family it grades.
 */

const JUDGE_PREAMBLE =
  "You are a strict, fair evaluator of another AI system's output. You are given the task input, the system's output, and a grading rubric. Grade ONLY against the rubric. Be skeptical: when the output is borderline, grade it down. Always explain your grade in one or two concrete sentences before you commit to a letter.";

/** Tune grade boundaries in the rubric, not here. */
const GRADE_TO_SCORE = {
  A: 1,
  B: 0.66,
  C: 0.33,
  D: 0,
} satisfies Record<"A" | "B" | "C" | "D", number>;

const judgeOutputSchema = z.object({
  feedback: z.string().min(1).describe("One or two concrete sentences justifying the grade."),
  grade: z.enum(["A", "B", "C", "D"]).describe("The letter grade from the rubric."),
});

export interface LlmJudgeOptions<TInput, TOutput, TExpected> {
  /** Scorer name shown in the evalite UI. */
  name: string;
  /** Say what earns each of A/B/C/D. Consistency comes from the rubric, not the model. */
  rubric: string;
  /** Builds the judge prompt: the thing to grade. */
  prompt: (args: { input: TInput; output: TOutput; expected: TExpected | undefined }) => string;
  /** Override the judge model. Defaults to `route("cheap")` (Gemini Flash-Lite). */
  model?: LanguageModel;
  /** Return a reason to score 0 without a judge call, for example when the provider was overloaded. */
  skipWhen?: (args: {
    input: TInput;
    output: TOutput;
    expected: TExpected | undefined;
  }) => string | null;
}

export function llmJudgeScorer<TInput, TOutput, TExpected>(
  opts: LlmJudgeOptions<TInput, TOutput, TExpected>,
) {
  return createScorer<TInput, TOutput, TExpected>({
    name: opts.name,
    scorer: async ({ input, output, expected }) => {
      const skipReason = opts.skipWhen?.({ input, output, expected });

      if (skipReason) return { score: 0, metadata: skipReason };

      try {
        const result = await generateObject({
          model: opts.model ?? route("cheap").model(),
          schema: judgeOutputSchema,
          instructions: `${JUDGE_PREAMBLE}\n\nRubric:\n${opts.rubric}`,
          prompt: opts.prompt({ input, output, expected }),
          temperature: 0,
          abortSignal: AbortSignal.timeout(60_000),
        });

        return {
          score: GRADE_TO_SCORE[result.object.grade],
          metadata: `${result.object.grade} — ${result.object.feedback}`,
        };
      } catch (error) {
        // Never throw: an evalite-beta reporter bug hangs the run on a scorer error.
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.warn(`[llm-judge] "${opts.name}" judge error: ${reason}`);

        return { score: 0, metadata: `judge error: ${reason}` };
      }
    },
  });
}
