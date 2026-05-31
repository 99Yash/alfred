import { serverEnv } from "@alfred/env/server";
import { renderSkillDocumentationEmail } from "@alfred/mailer";
import type { SkillDocumentationContext } from "./context";

/**
 * Deterministic email renderer for the "Skill documented" notification.
 *
 * The body of the email is *not* the documented skill body — that lives
 * in the app, where the user reviews + edits it. The email is a delivery
 * receipt: confirms the doc run completed, names the sources it scanned,
 * and links the user back. Matches dimension's shape:
 *
 *   subject  Skill documented: <name>
 *   body     greeting → provenance line → "What's covered" preview →
 *            CTA back to the app
 *
 * Why deterministic: the documented body itself is the LLM artifact;
 * generating an email summary on top with another LLM call would
 * double-bill compose with no signal. We extract the first ~600 chars
 * of the body as the "what's covered" preview — this is markdown the
 * user already approved (their v1 directives), so it reads cleanly.
 */

const PREVIEW_CHAR_BUDGET = 600;

export interface SkillDocumentationEmailArgs {
  context: SkillDocumentationContext;
  /** The newly-composed v2 body (the documented revision). */
  documentedBody: string;
  /**
   * Origin the email links/logo are built from. Defaults to the configured
   * web origin (`CORS_ORIGIN`), so the workflow doesn't have to thread it.
   */
  alfredUrl?: string;
}

export interface ComposedDocumentationEmail {
  subject: string;
  html: string;
  text: string;
}

export async function composeSkillDocumentationEmail(
  args: SkillDocumentationEmailArgs,
): Promise<ComposedDocumentationEmail> {
  const greetingName = firstName(args.context.user.name);
  const subject = `Skill documented: ${args.context.skill.name}`;

  const provenance = buildProvenanceLine(args.context);
  const preview = previewBody(args.documentedBody);

  const origin = (args.alfredUrl ?? serverEnv().CORS_ORIGIN).replace(/\/+$/, "");
  const skillUrl = `${origin}/skills/${args.context.skill.slug}`;
  // Raster PNG, not SVG: Gmail/Outlook drop inline SVG <img> to alt text.
  const logoUrl = `${origin}/images/logo/alfred-logo-email.png`;

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

/**
 * Build the dimension-style provenance preamble. Examples:
 *   "Analyzed 12 documents across Gmail and 3 memory notes for this skill."
 *   "No connected sources matched yet; this is a starting point."
 */
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
