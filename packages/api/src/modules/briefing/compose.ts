import { getBossModel, identifyLanguageModel, meteredGenerateObject } from "@alfred/ai";
import {
  briefingComposerSchema,
  fullBriefingSchema,
  type BriefingComposerOutput,
  type BriefingGather,
  type BriefingSlot,
  summarizeBody,
  toMessage,
  type FullBriefing,
  type IanaTimezone,
} from "@alfred/contracts";
import type { ComposedEmail } from "@alfred/mailer";

import type { BriefingDigest, BriefingItem, PriorityCategory } from "./gather";
import {
  buildBriefingSourcePanels,
  escapeHtml,
  listBriefingReferenceOptions,
  referencesFromSections,
} from "./references";

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
  urgent: "Urgent",
  action_needed: "Action needed",
  follow_up: "Follow ups",
  awaiting_reply: "Awaiting your reply",
  meeting: "Meetings",
  payment: "Payments",
};

const CATEGORY_ORDER: readonly PriorityCategory[] = [
  "urgent",
  "action_needed",
  "follow_up",
  "awaiting_reply",
  "meeting",
  "payment",
] as const;

// Role + rules + citation contract, sectioned per the Anthropic template. The
// actual ask and the output-shape rules live in `buildComposerPrompt` (the user
// message), which the model reads last — so the critical "what to produce"
// instruction is naturally end-positioned.
const BRIEFING_COMPOSER_SYSTEM_PROMPT = [
  "You compose Alfred's daily briefing for one user.",
  [
    "Rules:",
    "- Use only the provided gather payload. Never invent items, references, or facts that are not in it.",
    "- Write concise, user-facing prose. Do not expose private chain-of-thought or raw reasoning.",
    "- Prefer concrete operational outcomes over event noise.",
    "- If an issue failed and then resolved without user action, mention it only when the rollup shows notable pain.",
    "- Section `why` fields explain the inclusion in one sentence — not model reasoning.",
  ].join("\n"),
  [
    "Citations:",
    "- Use only the provided availableReferences list when citing source items.",
    "- Cite with [[email:<documentId>]], [[meeting:<eventId>]], or [[activity:<id>]] exactly as listed.",
    "- Do not emit URLs. Reference resolution adds links after compose.",
  ].join("\n"),
].join("\n\n");

export interface ComposeInboxBriefingArgs {
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

export interface ComposeBriefingArgs {
  userId: string;
  briefingDate: string;
  slot: BriefingSlot;
  timezone: IanaTimezone;
  gather: BriefingGather;
  runId?: string;
  stepId?: string;
  idempotencyKey?: string;
}

export interface ComposedBriefing {
  breakingSummary: string;
  fullBriefing: FullBriefing;
  modelId: string;
  composeFallback: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export async function composeBriefing(args: ComposeBriefingArgs): Promise<ComposedBriefing> {
  const model = getBossModel();
  try {
    const result = await meteredGenerateObject<BriefingComposerOutput>(
      {
        model,
        schema: briefingComposerSchema,
        schemaName: "briefing_composer",
        schemaDescription:
          "Composes a concise daily briefing from gathered email, calendar, integration activity, weather, and day context.",
        instructions: BRIEFING_COMPOSER_SYSTEM_PROMPT,
        prompt: buildComposerPrompt(args),
        temperature: 0.2,
        maxOutputTokens: 2_500,
      },
      {
        kind: "briefing",
        role: "briefing",
        userId: args.userId,
        runId: args.runId,
        stepId: args.stepId,
        idempotencyKey: args.idempotencyKey,
        requestMeta: {
          purpose: "briefing.compose",
          briefingDate: args.briefingDate,
          slot: args.slot,
          timezone: args.timezone,
          emailItems: countEmailItems(args.gather),
          activityItems: args.gather.integration_activity.items.length,
          calendarEvents: args.gather.calendar?.events.length ?? 0,
        },
        name: "briefing.compose",
      },
    );

    const fullBriefing = attachSourcePanels(result.object.fullBriefing, args.gather);
    return {
      breakingSummary: result.object.breakingSummary.trim(),
      fullBriefing,
      modelId: identifyLanguageModel(model).modelId,
      composeFallback: false,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };
  } catch (err) {
    return deterministicFallback(args, err);
  }
}

function buildComposerPrompt(args: ComposeBriefingArgs): string {
  return JSON.stringify(
    {
      task: "Compose today's briefing.",
      briefingDate: args.briefingDate,
      slot: args.slot,
      timezone: args.timezone,
      gather: composerSafeGather(args.gather),
      availableReferences: listBriefingReferenceOptions(args.gather),
      outputRules: {
        breakingSummary: "One short paragraph suitable for the email top summary.",
        fullBriefing: "Structured full-page briefing. Keep each section focused and scannable.",
        references: "Only use IDs present in availableReferences. Do not invent references.",
        sourcePanels: "Do not emit sourcePanels. They are generated by code after compose.",
      },
    },
    null,
    2,
  );
}

function composerSafeGather(gather: BriefingGather): BriefingGather {
  return {
    ...gather,
    integration_activity: {
      items: gather.integration_activity.items.map(({ url: _url, ...item }) => item),
    },
  };
}

function attachSourcePanels(
  fullBriefing: BriefingComposerOutput["fullBriefing"],
  gather: BriefingGather,
): FullBriefing {
  const references = referencesFromSections(fullBriefing.sections);
  return fullBriefingSchema.parse({
    ...fullBriefing,
    sourcePanels: buildBriefingSourcePanels(gather, references),
  });
}

function deterministicFallback(args: ComposeBriefingArgs, err: unknown): ComposedBriefing {
  const emailCount = countEmailItems(args.gather);
  const activityCount = args.gather.integration_activity.items.length;
  const meetingCount = args.gather.calendar?.events.length ?? 0;
  const lead =
    emailCount === 0 && activityCount === 0 && meetingCount === 0
      ? "No priority email, meetings, or integration activity stood out for today."
      : [
          emailCount ? `${emailCount} priority email${emailCount === 1 ? "" : "s"}` : null,
          meetingCount ? `${meetingCount} calendar event${meetingCount === 1 ? "" : "s"}` : null,
          activityCount
            ? `${activityCount} integration activit${activityCount === 1 ? "y" : "ies"}`
            : null,
        ]
          .filter(Boolean)
          .join(", ");

  const sections = fallbackSections(args.gather);
  const fullBriefing = fullBriefingSchema.parse({
    headline: "Daily briefing",
    sections,
    auditSummary: `Deterministic fallback used because composer failed: ${errorMessage(err)}`,
    sourcePanels: buildBriefingSourcePanels(args.gather, referencesFromSections(sections)),
  });

  return {
    breakingSummary: lead,
    fullBriefing,
    modelId: "deterministic-fallback",
    composeFallback: true,
  };
}

function fallbackSections(gather: BriefingGather): FullBriefing["sections"] {
  const sections: FullBriefing["sections"] = [];
  const emailCount = countEmailItems(gather);
  if (emailCount > 0) {
    const references = Object.values(gather.email.categories)
      .flatMap((items) => items ?? [])
      .slice(0, 8)
      .map((item) => `email:${item.documentId}`);
    sections.push({
      source: "email",
      label: "Priority email",
      body: `There ${emailCount === 1 ? "is" : "are"} ${emailCount} priority email${
        emailCount === 1 ? "" : "s"
      } in the current briefing window.`,
      why: "Email triage marked these messages as worth surfacing today.",
      references,
    });
  }

  const activity = gather.integration_activity.items;
  if (activity.length > 0) {
    sections.push({
      source: "integration_activity",
      label: "Integration activity",
      body: `${activity.length} activity item${activity.length === 1 ? "" : "s"} stood out across connected tools.`,
      why: "The activity rollup retained these items after suppressing routine or resolved noise.",
      references: activity.slice(0, 8).map((item) => `activity:${item.id}`),
    });
  }

  if (gather.calendar?.events.length) {
    sections.push({
      source: "calendar",
      label: "Calendar",
      body: `${gather.calendar.events.length} event${
        gather.calendar.events.length === 1 ? "" : "s"
      } are on the calendar today.`,
      why: "Calendar context affects what needs attention before or between meetings.",
      references: gather.calendar.events.slice(0, 8).map((event) => `meeting:${event.eventId}`),
    });
  }

  if (gather.weather) {
    sections.push({
      source: "weather",
      label: "Weather",
      body: `${gather.weather.current.description}; forecast high ${Math.round(
        gather.weather.forecast.highC,
      )}C and low ${Math.round(gather.weather.forecast.lowC)}C.`,
      why: "Weather is included for commute and day-planning context.",
    });
  }

  if (sections.length === 0) {
    sections.push({
      source: "day_of_week",
      label: "Today",
      body: `${gather.day_of_week.dayName} has no priority items in the current gather payload.`,
      why: "The briefing still records the day context and confirms there was nothing notable.",
    });
  }

  return sections;
}

function countEmailItems(gather: BriefingGather): number {
  return Object.values(gather.email.categories).reduce(
    (sum, items) => sum + (items?.length ?? 0),
    0,
  );
}

function errorMessage(err: unknown): string {
  return summarizeBody(toMessage(err));
}

export function composeInboxBriefing(args: ComposeInboxBriefingArgs): ComposedEmail {
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

function renderText(args: ComposeInboxBriefingArgs, greeting: string): string {
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

function renderHtml(args: ComposeInboxBriefingArgs, greeting: string): string {
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
    tail.push(`<p style="${MUTED_P_STYLE}">Also seen in the last 24h: ${parts.join(", ")}.</p>`);
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
