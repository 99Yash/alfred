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
  /** Optional URL the email links to as the "open in alfred" CTA. */
  alfredUrl?: string;
}

export interface ComposedDocumentationEmail {
  subject: string;
  html: string;
  text: string;
}

export function composeSkillDocumentationEmail(
  args: SkillDocumentationEmailArgs,
): ComposedDocumentationEmail {
  const greetingName = firstName(args.context.user.name);
  const subject = `Skill documented: ${args.context.skill.name}`;

  const provenance = buildProvenanceLine(args.context);
  const preview = previewBody(args.documentedBody);

  const skillUrl = args.alfredUrl
    ? `${args.alfredUrl.replace(/\/+$/, "")}/skills/${args.context.skill.slug}`
    : null;

  const text = renderText({ greetingName, provenance, preview, skillUrl });
  const html = renderHtml({ greetingName, provenance, preview, skillUrl });
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
  skillUrl: string | null;
}

function renderText({ greetingName, provenance, preview, skillUrl }: RenderArgs): string {
  const lines = [
    `Hi ${greetingName},`,
    "",
    provenance,
    "",
    `What's covered:`,
    "",
    preview,
    "",
  ];
  if (skillUrl) {
    lines.push(`Review or edit: ${skillUrl}`);
  } else {
    lines.push(`Open Alfred to review or edit.`);
  }
  return lines.join("\n");
}

function renderHtml({ greetingName, provenance, preview, skillUrl }: RenderArgs): string {
  const cta = skillUrl
    ? `<p><a href="${escapeHtml(skillUrl)}" style="color:#2563eb;">Review or edit this skill →</a></p>`
    : `<p>Open Alfred to review or edit.</p>`;
  return [
    `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; color: #111;">`,
    `  <p>Hi ${escapeHtml(greetingName)},</p>`,
    `  <p>${escapeHtml(provenance)}</p>`,
    `  <p style="margin-bottom: 4px;"><strong>What's covered:</strong></p>`,
    `  <pre style="white-space: pre-wrap; font-family: inherit; background: #f8fafc; padding: 12px 16px; border-radius: 6px; border: 1px solid #e2e8f0; font-size: 14px;">${escapeHtml(preview)}</pre>`,
    `  ${cta}`,
    `</div>`,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
