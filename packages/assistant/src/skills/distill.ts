import { route, meteredGenerateObject } from "@alfred/ai";
import { confidenceSchema } from "@alfred/contracts";
import { z } from "zod";
import type { SkillLearnContext } from "./context";
import { parseMentions, resolveMentions } from "./mentions";

/**
 * Cheap-tier distill, phase 1 of Learn. One structured call turns the prompt and memory
 * into fact proposals, a v1 markdown body, a name, and resolved mentions.
 * One call, not three, so the body, facts, and name agree. Cheap tier, because this only
 * restructures; `skill-documentation` does the heavy work.
 */

export const skillProposalSchema = z.object({
  /** Snake_case. Open vocabulary here, unlike cold-start's fixed bio keys. */
  key: z.string().min(1).max(120),
  /** A single string: Gemini structured output handles unions badly (ADR-0011). */
  value: z.string().min(1).max(2_000),
  confidence: confidenceSchema,
  rationale: z.string().min(1).max(500),
});

export type SkillProposal = z.infer<typeof skillProposalSchema>;

export const distillResultSchema = z.object({
  /** The auto-generated title. */
  suggestedName: z.string().min(1).max(80),
  /** Mounted verbatim in the system prompt at run time, so write directives, not commentary. */
  body: z.string().min(1).max(8_000),
  /** Same cap as cold-start. */
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
