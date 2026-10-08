import { route, meteredGenerateText } from "@alfred/ai";
import type { SkillDocumentationContext } from "./skill-documentation-context";

/**
 * Boss-tier compose, phase 2 of Learn. Rewrites the v1 body with retrieved evidence:
 * add named specifics without inventing them, keep every v1 directive, and stay imperative.
 * Boss tier because the cheap tier dropped specifics. One call per Learn click.
 */

const SYSTEM_PROMPT = `You are documenting a personal AI skill by enriching its existing body with evidence retrieved from the user's connected sources.

Inputs you will receive:
- The user's identity (name, email).
- The skill's current body — directives the user already approved.
- Confirmed facts about the user.
- Top retrieved chunks from the user's documents (gmail, etc.) and memory layer.

Rules:
1. PRESERVE the existing body's directives. Numbers, channels, formats the user specified must survive verbatim. Add detail; do not soften constraints.
2. GROUND new content in the retrieved evidence. Named entities (companies, products, people, dates) must come from the chunks/memory/facts you were given. Do not introduce specifics the inputs don't support.
3. The output is the *new skill body* — imperative directives the agent reads to act. Markdown is welcome (headings, bullets). Do NOT write a report or a recap; the user already knows the broad strokes.
4. Length: ~250–800 words. Long enough to capture the patterns the evidence reveals; short enough that an LLM mounts it as a system prompt without dominating the context budget.
5. If the retrieved evidence is too thin to add anything load-bearing, return the existing body unchanged. It is OK for v2 to be a near-copy of v1.

Output ONLY the markdown body. No preamble, no commentary, no fenced code block wrapper.`;

function buildUserPrompt(ctx: SkillDocumentationContext): string {
  const lines: string[] = [];
  lines.push(`# User`);
  lines.push(`- Name: ${ctx.user.name}`);
  lines.push(`- Email: ${ctx.user.email}`);
  lines.push("");
  lines.push(`# Skill: ${ctx.skill.name} (${ctx.skill.slug})`);
  lines.push("");
  lines.push(`## Current body (v1, distilled — preserve its directives)`);
  lines.push(ctx.skill.currentBody);
  lines.push("");
  lines.push(`## Confirmed user facts`);

  if (ctx.facts.length === 0) {
    lines.push(`(none)`);
  } else {
    for (const f of ctx.facts.slice(0, 60)) {
      const v = typeof f.value === "string" ? f.value : JSON.stringify(f.value);
      lines.push(`- ${f.key}: ${v}`);
    }
  }

  lines.push("");
  lines.push(`## Retrieved chunks from documents (${ctx.documentHits.length})`);

  if (ctx.documentHits.length === 0) {
    lines.push(`(no matches)`);
  } else {
    ctx.documentHits.forEach((h, i) => {
      // Typed `Date | null`, but run state is JSON, so on resume it is an ISO string.
      const stamp = h.authoredAt ? new Date(h.authoredAt).toISOString().slice(0, 10) : "n/a";
      lines.push(
        `- [${i + 1}] source=${h.source} title=${h.title ?? "(untitled)"} date=${stamp} sim=${h.similarity.toFixed(2)}`,
      );
      lines.push(`  ${h.preview}`);
    });
  }

  lines.push("");
  lines.push(`## Retrieved memory chunks (${ctx.memoryHits.length})`);

  if (ctx.memoryHits.length === 0) {
    lines.push(`(no matches)`);
  } else {
    ctx.memoryHits.forEach((h, i) => {
      lines.push(`- [${i + 1}] kind=${h.kind} sim=${h.similarity.toFixed(2)}`);
      lines.push(`  ${h.preview}`);
    });
  }

  return lines.join("\n");
}

export interface ComposeArgs {
  context: SkillDocumentationContext;
  runId?: string;
  stepId?: string;
  idempotencyKey?: string;
}

export interface ComposedDocumentation {
  body: string;
  /** For cost tracking on the revision metadata. */
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export async function composeSkillDocumentation(args: ComposeArgs): Promise<ComposedDocumentation> {
  const result = await meteredGenerateText(
    {
      model: route("boss").model(),
      instructions: SYSTEM_PROMPT,
      prompt: buildUserPrompt(args.context),
      temperature: 0.2,
      maxOutputTokens: 2_000,
    },
    {
      userId: args.context.userId,
      runId: args.runId,
      stepId: args.stepId,
      idempotencyKey: args.idempotencyKey,
      requestMeta: {
        purpose: "skill-documentation.compose",
        skillId: args.context.skill.id,
      },
      name: "skill-documentation.compose",
    },
  );

  return {
    body: result.text.trim(),
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
  };
}
