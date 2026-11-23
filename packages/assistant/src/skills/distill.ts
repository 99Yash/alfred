import { route, meteredGenerateObject } from "@alfred/ai";
import { toDisplayText } from "@alfred/contracts";
import { z } from "zod";
import type { SkillLearnContext } from "./context";
import { parseMentions, resolveMentions } from "./mentions";

/**
 * One cheap-route call with no reasoning that writes at most 4k tokens. Two minutes ends only a
 * hung call. The workflow step has no signal to combine.
 */
const DISTILL_TIMEOUT_MS = 120_000;

/**
 * Cheap-tier distill, phase 1 of Learn. One structured call turns the prompt and memory
 * into a v1 markdown body, a name, and resolved mentions. One call, so the body and the name
 * agree. Cheap tier, because this only restructures; `skill-documentation` does the heavy work.
 * It proposes no claims: a claim cites evidence in the raw record, and the skill prompt has no
 * stored link (ADR-0123).
 */
export const distillResultSchema = z.object({
  /** The auto-generated title. */
  suggestedName: z.string().min(1).max(80),
  /** Mounted verbatim in the system prompt at run time, so write directives, not commentary. */
  body: z.string().min(1).max(8_000),
});

export type DistillResult = z.infer<typeof distillResultSchema>;

const SYSTEM_PROMPT = `You convert a user's brief skill prompt into (1) a normalized skill body the agent can act on, and (2) a short title.

Rules:

1. STAY GROUNDED. Use only what the prompt and the provided existing memory support. Do not invent specifics (numbers, names, channels) not present.
2. The 'body' is what the agent reads to act. Write it as imperative directives, not narration. Bullet lists welcome. Inline @-mentions for integrations or other skills are preserved verbatim.
3. The 'suggestedName' is a short, human-readable title (≤80 chars). Lowercase nouns, no trailing period. Examples: "remote engineering jobs", "weekly newsletter to investors", "expense receipts".
4. If the prompt is too vague to produce a meaningful body, emit a body that asks the user to be more specific (don't fabricate).

Output strictly the JSON shape: { "suggestedName": "...", "body": "..." }`;

function buildUserPrompt(args: { context: SkillLearnContext; prompt: string }): string {
  const lines: string[] = [];
  lines.push(`# User`);
  lines.push(`- Name: ${args.context.user.name}`);
  lines.push(`- Email: ${args.context.user.email}`);
  lines.push("");
  lines.push(`# Connected integrations`);

  if (args.context.connectedIntegrations.length === 0) {
    lines.push(`(none yet)`);
  } else {
    for (const slug of args.context.connectedIntegrations) lines.push(`- @${slug}`);
  }

  lines.push("");
  lines.push(`# Existing skills (referenceable as @skill:<slug>)`);

  if (args.context.existingSkillSlugs.length === 0) {
    lines.push(`(none yet)`);
  } else {
    for (const slug of args.context.existingSkillSlugs) lines.push(`- @skill:${slug}`);
  }

  lines.push("");
  lines.push(`# Existing memory`);

  if (args.context.facts.length === 0) {
    lines.push(`(empty)`);
  } else {
    for (const f of args.context.facts) {
      const v = toDisplayText(f.value);
      lines.push(`- ${f.key}: ${v}`);
    }
  }

  lines.push("");
  lines.push(`# User's skill prompt`);
  lines.push(args.prompt);

  return lines.join("\n");
}

export interface DistillSkillArgs {
  context: SkillLearnContext;
  prompt: string;
  runId?: string;
  stepId?: string;
  idempotencyKey?: string;
}

export interface DistillSkillResult extends DistillResult {
  /** Parsed from the body, not the raw prompt. */
  mentions: ReturnType<typeof resolveMentions>;
}

export async function distillSkill(args: DistillSkillArgs): Promise<DistillSkillResult> {
  const result = await meteredGenerateObject<DistillResult>(
    {
      model: route("cheap").model(),
      instructions: SYSTEM_PROMPT,
      prompt: buildUserPrompt({ context: args.context, prompt: args.prompt }),
      schema: distillResultSchema,
      temperature: 0,
      maxOutputTokens: 4_000,
      abortSignal: AbortSignal.timeout(DISTILL_TIMEOUT_MS),
    },
    {
      userId: args.context.userId,
      runId: args.runId,
      stepId: args.stepId,
      idempotencyKey: args.idempotencyKey,
      requestMeta: { purpose: "learn-skill.distill" },
      name: "learn-skill.distill",
    },
  );

  const mentions = resolveMentions(parseMentions(result.output.body), {
    integrationSlugs: new Set(args.context.connectedIntegrations),
    skillSlugs: new Set(args.context.existingSkillSlugs),
  });

  return { ...result.output, mentions };
}
