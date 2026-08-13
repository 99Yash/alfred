import { route } from "@alfred/ai";
import { generateObject, type LanguageModel } from "ai";
import { createScorer } from "evalite";
import { z } from "zod";

const JUDGE_PREAMBLE =
  "You are a strict, fair evaluator of another AI system's output. You are given the task input, the system's output, and a grading rubric. Grade ONLY against the rubric. Be skeptical: when the output is borderline, grade it down. Always explain your grade in one or two concrete sentences before you commit to a letter.";

const GRADE_TO_SCORE: Record<"A" | "B" | "C" | "D", number> = {
  A: 1,
  B: 0.66,
  C: 0.33,
  D: 0,
};

const judgeOutputSchema = z.object({
  feedback: z.string().min(1).describe("One or two concrete sentences justifying the grade."),
  grade: z.enum(["A", "B", "C", "D"]).describe("The letter grade from the rubric."),
});

export interface LlmJudgeOptions<TInput, TOutput, TExpected> {
  name: string;
  rubric: string;
  prompt: (args: { input: TInput; output: TOutput; expected: TExpected | undefined }) => string;
  model?: LanguageModel;
  skipWhen?: (args: {
    input: TInput;
    output: TOutput;
    expected: TExpected | undefined;
  }) => string | null;
}

/** Build an evalite scorer backed by a bounded LLM judge. */
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
          model: opts.model ?? route("standard").model(),
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
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.warn(`[llm-judge] "${opts.name}" judge error: ${reason}`);
        return { score: 0, metadata: `judge error: ${reason}` };
      }
    },
  });
}
