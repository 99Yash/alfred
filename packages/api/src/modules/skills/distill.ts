import { getCheapModel, meteredGenerateObject } from "@alfred/ai";
import { confidenceSchema } from "@alfred/contracts";
import { z } from "zod";
import type { SkillLearnContext } from "./context";
import { parseMentions, resolveMentions } from "./mentions";

/**
 * Cheap-tier distillation — phase 1 of dimension's two-phase Learn.
 *
 * Takes the user's raw prompt + their existing memory and produces:
 *  - structured `user_facts` proposals (the "Memory update" panel),
 *  - a normalized markdown body (the v1 skill_revision),
 *  - a suggested skill name (the auto-generated title),
 *  - parsed `@`-mentions resolved against the user's registry.
 *
 * Why one structured-output call instead of three: the model needs to
 * see the prompt + memory once to do all four extractions coherently
 * (the body should reference the same facts the proposals capture; the
 * name should reflect the body's topic). Three round-trips would either
 * cost three times as much or drift apart on details.
 *
 * Why cheap-tier: this is constrained transformation, not reasoning.
 * The downstream `skill-documentation` workflow does the heavy lifting
 * with boss-tier + hybrid search; this step just structures what's
 * already on the page.
 */

export const skillProposalSchema = z.object({
  /**
   * Snake_case key. Open vocabulary at the skill-distill stage —
   * authoring prompts can produce arbitrary preference shapes
   * ("salary_floor_usd", "preferred_subject_line_style"), unlike
   * cold-start where we constrained to a fixed bio vocabulary.
   */
  key: z.string().min(1).max(120),
  /** Single-string value (Gemini struct-output handles unions inconsistently — see ADR-0011 distill notes). */
  value: z.string().min(1).max(2_000),
  confidence: confidenceSchema,
  /** One sentence on why this fact follows from the prompt. */
  rationale: z.string().min(1).max(500),
});
export type SkillProposal = z.infer<typeof skillProposalSchema>;

export const distillResultSchema = z.object({
  /** ≤80-char human-readable name. The auto-generated title. */
  suggestedName: z.string().min(1).max(80),
  /**
   * Normalized skill body (markdown). The agent mounts this verbatim
   * into its system prompt at skill-execution time, so it should read
   * as a directive ("Do X. Filter for Y.") not as commentary.
   */
  body: z.string().min(1).max(8_000),
  /** Up to 20 fact proposals — same conservative gating as cold-start. */
  proposals: z.array(skillProposalSchema).max(20),
});
export type DistillResult = z.infer<typeof distillResultSchema>;

const SYSTEM_PROMPT = `You convert a user's brief skill prompt into (1) a structured set of memory facts about the user, (2) a normalized skill body the agent can act on, and (3) a short title.

Rules:

1. STAY GROUNDED. Only emit facts the prompt + provided existing memory actually supports. Do not invent specifics (numbers, names, channels) not present.
2. The 'body' is what the agent reads to act. Write it as imperative directives, not narration. Bullet lists welcome. Inline @-mentions for integrations or other skills are preserved verbatim.
3. The 'suggestedName' is a short, human-readable title (≤80 chars). Lowercase nouns, no trailing period. Examples: "remote engineering jobs", "weekly newsletter to investors", "expense receipts".
4. PROPOSALS are user_facts the prompt newly asserts about the user — preferences, criteria, working patterns. NOT facts about the world. Keys are snake_case ("salary_floor_usd", "remote_only", "preferred_application_channels"). Values are single strings. Skip anything <0.7 confidence.
5. Skip proposals for things already captured in the existing-memory section — the user has them.
6. If the prompt is too vague to produce a meaningful body, emit a body that asks the user to be more specific (don't fabricate). Set proposals to [].

Output strictly the JSON shape: { "suggestedName": "...", "body": "...", "proposals": [{ "key": "...", "value": "...", "confidence": 0.0-1.0, "rationale": "..." }, ...] }`;

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
  lines.push(`# Existing memory (do NOT re-propose these)`);
  if (args.context.facts.length === 0) {
    lines.push(`(empty)`);
  } else {
    for (const f of args.context.facts) {
      const v = typeof f.value === "string" ? f.value : JSON.stringify(f.value);
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
  /** Mentions parsed out of the *body* (not the user's raw prompt) and resolved against the registry. */
  mentions: ReturnType<typeof resolveMentions>;
}

export async function distillSkill(args: DistillSkillArgs): Promise<DistillSkillResult> {
  const result = await meteredGenerateObject<DistillResult>(
    {
      model: getCheapModel(),
      instructions: SYSTEM_PROMPT,
      prompt: buildUserPrompt({ context: args.context, prompt: args.prompt }),
      schema: distillResultSchema,
      temperature: 0,
      maxOutputTokens: 4_000,
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

  const mentions = resolveMentions(parseMentions(result.object.body), {
    integrationSlugs: new Set(args.context.connectedIntegrations),
    skillSlugs: new Set(args.context.existingSkillSlugs),
  });

  return { ...result.object, mentions };
}
