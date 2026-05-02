import type { BriefingDigest, BriefingItem, PriorityCategory } from "./gather";

/**
 * Deterministic HTML+text renderer for the inbox-only morning briefing.
 *
 * v1 deliberately skips an LLM compose step:
 *  - the structured digest from `gatherBriefingDigest` already carries
 *    each item's classifier rationale (a short LLM-grounded sentence),
 *    so a deterministic list reads as well as a re-summarised one;
 *  - cron-driven sends should be cost-floor-stable; running the cheap
 *    model per send is fine, but $0 is better;
 *  - rendering bugs are easy to triage when the template is in code,
 *    not the model.
 *
 * If/when ADR-0025's "schedule + relevant updates" sections ship,
 * this is the spot to swap the body for a `metered.text()` call with
 * the digest serialised as the prompt.
 */

const CATEGORY_LABEL: Record<PriorityCategory, string> = {
  action_needed: "Action needed",
  awaiting_reply: "Awaiting your reply",
  meeting: "Meetings",
  payment: "Payments",
};

const CATEGORY_ORDER: readonly PriorityCategory[] = [
  "action_needed",
  "awaiting_reply",
  "meeting",
  "payment",
] as const;

export interface ComposedBriefing {
  subject: string;
  html: string;
  text: string;
}

export interface ComposeBriefingArgs {
  digest: BriefingDigest;
  /** Greeting name — usually the user's first name. Falls back to "there". */
  recipientName?: string | null;
  /** Local date label, e.g. "Saturday, May 2". Computed in user's tz. */
  dateLabel: string;
  /**
   * URL the email links to as the "open Alfred" CTA. Optional — when
   * omitted, the CTA is hidden.
   */
  alfredUrl?: string;
}

export function composeBriefing(args: ComposeBriefingArgs): ComposedBriefing {
  const greeting = args.recipientName ? `Good morning, ${args.recipientName}` : "Good morning";
  const subject = subjectLine(args.digest, args.dateLabel);
  const text = renderText(args, greeting);
  const html = renderHtml(args, greeting);
  return { subject, html, text };
}

function subjectLine(digest: BriefingDigest, dateLabel: string): string {
  if (digest.totalPriority === 0) {
    return `Alfred · ${dateLabel} · inbox is clear`;
  }
  const noun = digest.totalPriority === 1 ? "item" : "items";
  return `Alfred · ${dateLabel} · ${digest.totalPriority} priority ${noun}`;
}

function renderText(args: ComposeBriefingArgs, greeting: string): string {
  const lines: string[] = [];
  lines.push(`${greeting}.`);
  lines.push("");
  lines.push(`Here's your inbox briefing for ${args.dateLabel}.`);
  lines.push("");

  if (args.digest.totalPriority === 0) {
    lines.push("Nothing in the priority buckets — your inbox is clear.");
  } else {
    for (const cat of CATEGORY_ORDER) {
      const bucket = args.digest.buckets[cat];
      if (!bucket.length) continue;
      lines.push(`== ${CATEGORY_LABEL[cat]} (${bucket.length}) ==`);
      for (const item of bucket) {
        lines.push(formatItemText(item));
      }
      lines.push("");
    }
  }

  if (args.digest.totalSuppressed > 0) {
    const parts: string[] = [];
    if (args.digest.suppressedCounts.newsletter > 0) {
      parts.push(`${args.digest.suppressedCounts.newsletter} newsletter(s)`);
    }
    if (args.digest.suppressedCounts.fyi > 0) {
      parts.push(`${args.digest.suppressedCounts.fyi} FYI`);
    }
    lines.push(`Also seen in the last 24h: ${parts.join(", ")}.`);
  }

  if (args.alfredUrl) {
    lines.push("");
    lines.push(`Open Alfred: ${args.alfredUrl}`);
  }

  return lines.join("\n");
}

function formatItemText(item: BriefingItem): string {
  const subject = item.subject?.trim() || "(no subject)";
  const fromShort = shortenFrom(item.from);
  const head = fromShort ? `• ${subject} — ${fromShort}` : `• ${subject}`;
  const rationale = item.rationale ? `\n    ${item.rationale}` : "";
  const link = item.threadUrl ? `\n    ${item.threadUrl}` : "";
  return `${head}${rationale}${link}`;
}

function renderHtml(args: ComposeBriefingArgs, greeting: string): string {
  const sections: string[] = [];
  if (args.digest.totalPriority === 0) {
    sections.push(
      `<p style="${P_STYLE}">Nothing in the priority buckets — your inbox is clear.</p>`,
    );
  } else {
    for (const cat of CATEGORY_ORDER) {
      const bucket = args.digest.buckets[cat];
      if (!bucket.length) continue;
      sections.push(renderBucketHtml(cat, bucket));
    }
  }

  const tail: string[] = [];
  if (args.digest.totalSuppressed > 0) {
    const parts: string[] = [];
    if (args.digest.suppressedCounts.newsletter > 0) {
      parts.push(`${args.digest.suppressedCounts.newsletter} newsletter(s)`);
    }
    if (args.digest.suppressedCounts.fyi > 0) {
      parts.push(`${args.digest.suppressedCounts.fyi} FYI`);
    }
    tail.push(
      `<p style="${MUTED_P_STYLE}">Also seen in the last 24h: ${parts.join(", ")}.</p>`,
    );
  }

  if (args.alfredUrl) {
    tail.push(
      `<p style="${P_STYLE}"><a href="${escapeHtml(args.alfredUrl)}" style="${LINK_STYLE}">Open Alfred →</a></p>`,
    );
  }

  return [
    `<div style="${WRAPPER_STYLE}">`,
    `  <p style="${P_STYLE}">${escapeHtml(greeting)}.</p>`,
    `  <p style="${P_STYLE}">Here's your inbox briefing for <strong>${escapeHtml(args.dateLabel)}</strong>.</p>`,
    sections.join("\n"),
    tail.join("\n"),
    `</div>`,
  ].join("\n");
}

function renderBucketHtml(category: PriorityCategory, bucket: BriefingItem[]): string {
  const itemsHtml = bucket.map(renderItemHtml).join("\n");
  return [
    `  <h2 style="${H2_STYLE}">${escapeHtml(CATEGORY_LABEL[category])} <span style="${COUNT_STYLE}">(${bucket.length})</span></h2>`,
    `  <ul style="${UL_STYLE}">`,
    itemsHtml,
    `  </ul>`,
  ].join("\n");
}

function renderItemHtml(item: BriefingItem): string {
  const subject = escapeHtml(item.subject?.trim() || "(no subject)");
  const fromShort = shortenFrom(item.from);
  const fromHtml = fromShort
    ? `<span style="${MUTED_INLINE_STYLE}"> — ${escapeHtml(fromShort)}</span>`
    : "";
  const titleHtml = item.threadUrl
    ? `<a href="${escapeHtml(item.threadUrl)}" style="${LINK_STYLE}">${subject}</a>`
    : subject;
  const rationale = item.rationale
    ? `<div style="${RATIONALE_STYLE}">${escapeHtml(item.rationale)}</div>`
    : "";
  return [
    `    <li style="${LI_STYLE}">`,
    `      <div><strong>${titleHtml}</strong>${fromHtml}</div>`,
    `      ${rationale}`,
    `    </li>`,
  ].join("\n");
}

/**
 * Trim a typical RFC-5322 `From: "Display Name" <addr@example.com>` to
 * just the display name, falling back to the address.
 */
function shortenFrom(from: string | null): string | null {
  if (!from) return null;
  const trimmed = from.trim();
  const angleMatch = trimmed.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (angleMatch) {
    const name = angleMatch[1]?.trim();
    if (name) return name;
    return angleMatch[2] ?? null;
  }
  return trimmed;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Inline styles only — Gmail strips <style> blocks, and inlining is the
// only reliable way to get consistent rendering across email clients.
const WRAPPER_STYLE =
  'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; color: #1a1a1a; line-height: 1.5;';
const P_STYLE = "margin: 0 0 16px 0; font-size: 15px;";
const MUTED_P_STYLE = "margin: 24px 0 0 0; font-size: 13px; color: #6b6b6b;";
const H2_STYLE = "font-size: 14px; font-weight: 600; margin: 24px 0 8px 0; color: #1a1a1a;";
const COUNT_STYLE = "color: #6b6b6b; font-weight: 400;";
const UL_STYLE = "margin: 0; padding-left: 20px;";
const LI_STYLE = "margin-bottom: 12px; font-size: 14px;";
const MUTED_INLINE_STYLE = "color: #6b6b6b; font-weight: 400;";
const RATIONALE_STYLE = "color: #6b6b6b; font-size: 13px; margin-top: 2px;";
const LINK_STYLE = "color: #2563eb; text-decoration: none;";
