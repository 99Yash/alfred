import { emailLogoUrl } from "@alfred/assistant/settings";
import { serverEnv } from "@alfred/env/server";
import type { ComposedEmail } from "@alfred/assistant/delivery";
import { renderSkillDocumentationEmail } from "@alfred/mailer";
import type { SkillDocumentationContext } from "./skill-documentation-context";

/**
 * "Skill documented" email. A delivery receipt, not the body: it names the sources and
 * previews the first ~600 chars. Deterministic, because a second LLM call adds cost and nothing else.
 */

const PREVIEW_CHAR_BUDGET = 600;

export interface SkillDocumentationEmailArgs {
  context: SkillDocumentationContext;
  /** The documented (v2) body. */
  documentedBody: string;
  /** Defaults to `CORS_ORIGIN`. */
  alfredUrl?: string;
}

export async function composeSkillDocumentationEmail(
  args: SkillDocumentationEmailArgs,
): Promise<ComposedEmail> {
  const greetingName = firstName(args.context.user.name);
  const subject = `Skill documented: ${args.context.skill.name}`;

  const provenance = buildProvenanceLine(args.context);
  const preview = previewBody(args.documentedBody);

  const origin = (args.alfredUrl ?? serverEnv().CORS_ORIGIN).replace(/\/+$/, "");
  const skillUrl = `${origin}/skills/${args.context.skill.slug}`;
  const logoUrl = emailLogoUrl(origin);

  const text = renderText({ greetingName, provenance, preview, skillUrl });

  const html = await renderSkillDocumentationEmail({
    greetingName,
    provenance,
    preview,
    skillUrl,
    logoUrl,
  });

  return { subject, html, text };
}

function firstName(full: string | undefined | null): string {
  if (!full) return "there";
  const trimmed = full.trim();

  if (!trimmed) return "there";

  return trimmed.split(/\s+/)[0] ?? "there";
}

/** E.g. "Analyzed 12 documents across Gmail and 3 memory notes for this skill." */
function buildProvenanceLine(ctx: SkillDocumentationContext): string {
  const docCount = ctx.documentHits.length;
  const memCount = ctx.memoryHits.length;
  const sourceLabels = Object.keys(ctx.sourceCounts);

  if (docCount === 0 && memCount === 0) {
    return `No connected sources matched yet; this is a starting point.`;
  }

  const parts: string[] = [];

  if (docCount > 0) {
    const fromClause = sourceLabels.length > 0 ? ` across ${humanList(sourceLabels)}` : "";
    parts.push(`${docCount} document chunk${docCount === 1 ? "" : "s"}${fromClause}`);
  }

  if (memCount > 0) {
    parts.push(`${memCount} memory note${memCount === 1 ? "" : "s"}`);
  }

  return `Analyzed ${humanList(parts)} to enrich this skill.`;
}

function humanList(items: string[]): string {
  if (items.length === 0) return "";

  if (items.length === 1) return items[0]!;

  if (items.length === 2) return `${items[0]} and ${items[1]}`;

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function previewBody(body: string): string {
  const trimmed = body.trim();

  if (trimmed.length <= PREVIEW_CHAR_BUDGET) return trimmed;
  // Cut on a paragraph boundary if there is one inside the budget.
  const slice = trimmed.slice(0, PREVIEW_CHAR_BUDGET);
  const lastBreak = slice.lastIndexOf("\n\n");
  const cut = lastBreak > PREVIEW_CHAR_BUDGET / 2 ? slice.slice(0, lastBreak) : slice;

  return `${cut.trim()}…`;
}

interface RenderArgs {
  greetingName: string;
  provenance: string;
  preview: string;
  skillUrl: string;
}

function renderText({ greetingName, provenance, preview, skillUrl }: RenderArgs): string {
  return [
    `Hi ${greetingName},`,
    "",
    provenance,
    "",
    `What's covered:`,
    "",
    preview,
    "",
    `Review or edit: ${skillUrl}`,
  ].join("\n");
}
