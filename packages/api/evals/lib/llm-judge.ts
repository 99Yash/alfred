import { getChatModel } from "@alfred/ai";
import { generateObject, type LanguageModel } from "ai";
import { createScorer } from "evalite";
import { z } from "zod";

/**
 * LLM-as-a-judge scorer factory (ADR-0055). Deterministic scorers cover the
 * hard signals — exact category match, "did a todo mint" — but the things we
 * keep hand-tuning the triage rubric for (is the *reasoning* sound? is the todo
 * title written the way a human would jot it?) are subjective, and that is what
 * a judge is for.
 *
 * Two deliberate choices, both load-bearing:
 *
 *  - **Letter grades, not numbers.** LLMs are biased toward round numbers (a 7,
 *    an 8) and grade inconsistently on a 0–100 scale. We make the judge pick a
 *    LETTER (A/B/C/D) against an explicit rubric and map it to a number in code.
 *    The grade boundaries live in the rubric prose, not the model's arithmetic.
 *  - **Feedback is required and surfaced as metadata.** A bare score is not
 *    debuggable. The judge must explain itself; that explanation shows up in the
 *    evalite UI's per-case panel so a regression is legible at a glance.
 *
 * The judge runs on the standard chat model (Sonnet), deliberately a DIFFERENT
 * and stronger model than the cheap classifier under test (Gemini Flash-Lite) —
 * a judge grading its own family's output is the classic self-preference trap.
 */

const JUDGE_PREAMBLE =
  "You are a strict, fair evaluator of another AI system's output. You are given the task input, the system's output, and a grading rubric. Grade ONLY against the rubric. Be skeptical: when the output is borderline, grade it down. Always explain your grade in one or two concrete sentences before you commit to a letter.";

/**
 * Letter → score. A is a clean pass, D is a clear fail; B/C are the graded
 * middle so a "mostly right, one flaw" case doesn't read as a total failure.
 * Tune the boundaries in the rubric, not here.
 */
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
  /** Scorer name shown in the evalite UI. */
  name: string;
  /**
   * The grading rubric. Spell out what earns each of A/B/C/D explicitly — the
   * judge's consistency comes from the rubric, not the model. Appended to the
   * judge system prompt.
   */
  rubric: string;
  /** Builds the user-facing judge prompt (the thing to grade) from the eval triple. */
  prompt: (args: { input: TInput; output: TOutput; expected: TExpected | undefined }) => string;
  /** Override the judge model. Defaults to the standard chat model (Sonnet). */
  model?: LanguageModel;
  /**
   * Short-circuit predicate. When it returns a string, the judge is NOT called:
   * the scorer returns `{ score: 0, metadata: <string> }`. Used to avoid
   * spending a judge call on a case the task could not produce real output for
   * (e.g. skipped on provider overload).
   */
  skipWhen?: (args: { input: TInput; output: TOutput; expected: TExpected | undefined }) =>
    | string
    | null;
}

/**
 * Build an evalite scorer backed by an LLM judge. Returns a `createScorer`
 * result usable directly in an eval's `scorers` array.
 */
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
          model: opts.model ?? getChatModel("standard"),
          schema: judgeOutputSchema,
          system: `${JUDGE_PREAMBLE}\n\nRubric:\n${opts.rubric}`,
          prompt: opts.prompt({ input, output, expected }),
          temperature: 0,
        });
        return {
          score: GRADE_TO_SCORE[result.object.grade],
          metadata: `${result.object.grade} — ${result.object.feedback}`,
        };
      } catch (err) {
        // A scorer must never throw: an errored eval trips an evalite-beta
        // reporter bug that hangs the run until the CI job timeout. A judge-model
        // failure (overload, `Output.object` parse) is infra, not a real grade,
        // so score 0 and surface why.
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.warn(`[llm-judge] "${opts.name}" judge error: ${reason}`);
        return { score: 0, metadata: `judge error: ${reason}` };
      }
    },
  });
}
