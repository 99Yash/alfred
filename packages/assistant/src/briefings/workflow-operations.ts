import { gatherBriefingWithSuppressionAudit, type BriefingInstructionSuppression } from "./gather";
import { inZone, parseLocalDateKey } from "@alfred/assistant/time";
import { resolveBriefingPreferences } from "./preferences";
import { fetchLatestWatermark, isQuietMorning } from "./read";
import {
  beginBriefing,
  markBriefingComposed,
  markBriefingComposing,
  markBriefingFailed,
  markBriefingGathering,
  markBriefingSent,
  markBriefingSuppressed,
} from "./store";
import { send } from "@alfred/assistant/delivery";
import { emailLogoUrl } from "@alfred/assistant/settings";
import type { StepContext, StepResult } from "@alfred/assistant/execution";
import {
  parseIanaTimezone,
  type BriefingClosedLoop,
  type BriefingGather,
  type BriefingLoopRelevance,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { renderBriefingEmail } from "@alfred/mailer";
import { eq } from "drizzle-orm";
import { runBriefingAgent } from "./agent/agent";
import {
  auditComposedBriefing,
  describeOpenAskViolation,
  downgradeOpenAsks,
  filterDroppedCitations,
  type ComposedBriefingBody,
  type OpenAskViolation,
} from "./open-ask-guard";

/**
 * Daily briefing workflow (ADR-0048): two slots, a watermark delta, and prior-briefing memory.
 * Writes `briefings` through the `store.ts` state machine.
 * Steps:
 *   1. gather: begin or resume the row, freeze the window (last watermark to now), run the
 *      deterministic gather for the suppression signal.
 *   2. compose: a quiet cron morning suppresses with no LLM call. Otherwise run the agent.
 *   3. send: render the email, `notify()` with a slot-scoped idempotency key, mark sent.
 * The agent emits one markdown body: `breaking_summary` is `bodyMarkdown`, and
 * `full_briefing` is `{ headline: subject, sections: [] }`.
 * Morning may suppress; evening and manual runs always send.
 */

export interface DailyBriefingOperationState {
  slot: "morning" | "evening";
  reason: "cron" | "manual" | "forced";
  dryRun: boolean;
  briefingDate?: string;
  timezone?: string;
  recipientName?: string | null;
  sinceIngestedAt?: string | null;
  untilIngestedAt?: string;
  briefingId?: string;
  quietDay?: boolean;
  closedLoops: BriefingClosedLoop[];
  /** Non-closing relevance verdicts for the live priority loops. */
  loopRelevance: BriefingLoopRelevance[];
  composed?: {
    subject: string;
    bodyText: string;
    bodyMarkdown: string;
    citedDocumentIds: string[];
    modelId: string;
  };
}

export async function runDailyBriefingGather<State extends DailyBriefingOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State>> {
  const prefs = await resolveBriefingPreferences(ctx.userId);
  const timezone = prefs.timezone;

  // Persisted JSON, so the date comes back as a string.
  const briefingDate = ctx.state.briefingDate
    ? parseLocalDateKey(ctx.state.briefingDate)
    : inZone(timezone).day();

  const begun = await beginBriefing({
    userId: ctx.userId,
    briefingDate,
    slot: ctx.state.slot,
    timezone,
    agentRunId: ctx.runId,
  });

  // The unique index blocks a double send; return the terminal row's outcome.
  if (begun.action === "skip_terminal") {
    await ctx.log(
      `gather: skip existing terminal briefing id=${begun.row.id} status=${begun.row.status}`,
    );

    return {
      kind: "done",
      state: { ...ctx.state, briefingId: begun.row.id, briefingDate, timezone },
      output: {
        briefingId: begun.row.id,
        briefingDate,
        slot: ctx.state.slot,
        status: begun.row.status,
        emailSendId: begun.row.emailSendId,
      },
    };
  }

  // A prior run composed but crashed before send. Reuse that prose: a fresh
  // compose wastes a boss-tier call and shifts the watermark window (#158).
  // Only `composed` has prose to reuse.
  if (begun.action === "resume" && begun.row.status === "composed") {
    const { breakingSummary, fullBriefing, watermarkAt } = begun.row;

    // Send needs the frozen window end too, so the watermark stops where the prose stops (#158).
    // A row without it (legacy) falls through to a fresh compose.
    if (breakingSummary && fullBriefing && watermarkAt) {
      await ctx.log(
        `gather: resume composed briefing id=${begun.row.id} — skipping to send ` +
          `(reuse prose, watermark=${watermarkAt.toISOString()})`,
      );

      return {
        kind: "next",
        state: {
          ...ctx.state,
          briefingId: begun.row.id,
          briefingDate,
          timezone,
          // `bodyText` and citations are not persisted, so reuse the markdown and no citations.
          // Use the frozen window end, not now.
          untilIngestedAt: watermarkAt.toISOString(),
          composed: {
            subject: fullBriefing.headline,
            bodyText: breakingSummary,
            bodyMarkdown: breakingSummary,
            citedDocumentIds: fullBriefing.surfacedDocumentIds ?? [],
            modelId: begun.row.model ?? "unknown",
          },
        },
        nextStep: "send",
      };
    }
  }

  const userRows = await db().select({ name: user.name }).from(user).where(eq(user.id, ctx.userId));
  const recipientName = pickFirstName(userRows[0]?.name ?? null);

  const since = await fetchLatestWatermark({ userId: ctx.userId, slot: ctx.state.slot });
  const until = new Date();

  let gather: BriefingGather;
  let suppressedByInstruction: BriefingInstructionSuppression[] = [];
  let closedLoops: BriefingClosedLoop[] = [];
  let loopRelevance: BriefingLoopRelevance[] = [];

  try {
    // Cheap deterministic gather over the same window. Feeds suppression and the surface;
    // the agent still writes the prose.
    const gathered = await gatherBriefingWithSuppressionAudit({
      userId: ctx.userId,
      briefingDate,
      slot: ctx.state.slot,
      timezone,
      windowStart: since ?? undefined,
      windowEnd: until,
    });

    gather = gathered.gather;
    suppressedByInstruction = gathered.suppressedByInstruction;
    closedLoops = gathered.closedLoops;
    loopRelevance = gathered.loopRelevance;
    await markBriefingGathering({ briefingId: begun.row.id, gather, closedLoops });
  } catch (err) {
    await markBriefingFailed(begun.row.id);
    throw err;
  }

  const counts = gatherCounts(gather);
  // Quiet means no `demanding` email, no activity, and no meetings (ADR-0064).
  // With no demand signal, fall back to the raw email count.
  const demandingEmailCount = gather.day_shape?.demandingEmailCount;

  const quietDay = isQuietMorning({
    demandingEmailCount,
    emailCount: counts.email,
    activityCount: counts.activity,
    meetingCount: counts.meetings,
  });

  await ctx.log(
    `gather: id=${begun.row.id} action=${begun.action} tz=${timezone} date=${briefingDate} ` +
      `since=${since ? since.toISOString() : "(first run)"} until=${until.toISOString()} ` +
      `email=${counts.email} demanding=${demandingEmailCount ?? "n/a"} topBand=${gather.day_shape?.topEmailBand ?? "n/a"} ` +
      `activity=${counts.activity} meetings=${counts.meetings} quiet=${quietDay}${instructionSuppressionLogPart(suppressedByInstruction)}`,
  );

  return {
    kind: "next",
    state: {
      ...ctx.state,
      briefingId: begun.row.id,
      briefingDate,
      timezone,
      recipientName,
      sinceIngestedAt: since ? since.toISOString() : null,
      untilIngestedAt: until.toISOString(),
      quietDay,
      closedLoops,
      loopRelevance,
    },
    nextStep: "compose",
  };
}

export async function runDailyBriefingCompose<State extends DailyBriefingOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State>> {
  const { briefingId, untilIngestedAt } = ctx.state;

  if (!briefingId || !untilIngestedAt || !ctx.state.briefingDate || !ctx.state.timezone) {
    throw new Error("[daily-briefing] compose entered without gather output");
  }

  // Persisted state is plain strings; parse the day key and zone here.
  const briefingDate = parseLocalDateKey(ctx.state.briefingDate);
  const timezone = parseIanaTimezone(ctx.state.timezone);

  // A quiet cron morning suppresses before the agent runs, so it costs no LLM call.
  if (ctx.state.slot === "morning" && ctx.state.reason === "cron" && ctx.state.quietDay) {
    const gateReason =
      "quiet morning: no demanding email, integration activity, or calendar events";

    if (!ctx.state.dryRun) {
      await markBriefingSuppressed({
        briefingId,
        watermarkAt: new Date(untilIngestedAt),
        gateReason,
      });
    }

    await ctx.log(`compose: suppressed (${gateReason})${ctx.state.dryRun ? " [dryRun]" : ""}`);

    return {
      kind: "done",
      state: ctx.state,
      output: {
        briefingId,
        status: ctx.state.dryRun ? "dry_run" : "suppressed",
        briefingDate,
        slot: ctx.state.slot,
        emailSendId: null,
      },
    };
  }

  const since = ctx.state.sinceIngestedAt ? new Date(ctx.state.sinceIngestedAt) : null;
  const until = new Date(untilIngestedAt);

  await markBriefingComposing(briefingId);

  let result: Awaited<ReturnType<typeof runBriefingAgent>>;
  let body: ComposedBriefingBody;
  let surfacedDocumentIds: string[] = [];

  try {
    const compose = async (openAskViolations?: readonly OpenAskViolation[]) => {
      return runBriefingAgent({
        userId: ctx.userId,
        slot: ctx.state.slot,
        recipientFirstName: ctx.state.recipientName ?? null,
        sinceIngestedAt: since,
        untilIngestedAt: until,
        briefingDate,
        timezone,
        runId: ctx.runId,
        stepId: "compose",
        closedLoops: ctx.state.closedLoops,
        loopRelevance: ctx.state.loopRelevance,
        ...(openAskViolations ? { openAskViolations } : {}),
      });
    };

    const audit = async (draft: ComposedBriefingBody) => {
      return auditComposedBriefing({
        userId: ctx.userId,
        composed: draft,
        closedLoops: ctx.state.closedLoops,
      });
    };

    result = await compose();
    body = result.briefing;

    // Open-ask guard (#1082): one aimed re-prompt, then a downgrade, then failure.
    // The guard may block or drop, never write prose.
    let violations = await audit(body);

    if (violations.length > 0) {
      await ctx.log(`compose: open-ask guard rejected draft 1 — ${describeViolations(violations)}`);
      result = await compose(violations);
      body = result.briefing;
      violations = await audit(body);
    }

    surfacedDocumentIds = uniqueStrings(result.briefing.citedDocumentIds);

    if (violations.length > 0) {
      const downgraded = downgradeOpenAsks(body, violations);

      if (!downgraded) {
        throw new Error(
          `[daily-briefing] open-ask guard blocked compose: ${describeViolations(violations)}`,
        );
      }

      await ctx.log(
        `compose: open-ask guard downgraded draft 2 — ${describeViolations(violations)}`,
      );
      body = { ...body, ...downgraded };
      // Keep only citations that went out, or the next slot hides an untold item.
      surfacedDocumentIds = filterDroppedCitations(result.briefing.citedDocumentIds, violations);
    }

    await markBriefingComposed({
      briefingId,
      // One markdown body, no structured sections.
      breakingSummary: body.bodyMarkdown,
      fullBriefing: {
        headline: body.subject,
        sections: [],
        surfacedDocumentIds,
      },
      model: result.modelId,
      composeFallback: false,
      // The window end this prose covers, so a resume never skips later docs (#158).
      watermarkAt: until,
    });
  } catch (err) {
    await markBriefingFailed(briefingId);
    throw err;
  }

  await ctx.log(
    `compose: steps=${result.steps} model=${result.modelId} ` +
      `in=${result.usage.inputTokens ?? 0} out=${result.usage.outputTokens ?? 0} ` +
      `subject="${body.subject}"`,
  );

  return {
    kind: "next",
    state: {
      ...ctx.state,
      composed: {
        subject: body.subject,
        bodyText: body.bodyText,
        bodyMarkdown: body.bodyMarkdown,
        citedDocumentIds: surfacedDocumentIds,
        modelId: result.modelId,
      },
    },
    nextStep: "send",
  };
}

function describeViolations(violations: readonly OpenAskViolation[]): string {
  return violations.map(describeOpenAskViolation).join(" | ");
}

export async function runDailyBriefingSend<State extends DailyBriefingOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State>> {
  const { composed, briefingId, briefingDate, untilIngestedAt } = ctx.state;

  if (!composed || !briefingId || !briefingDate || !untilIngestedAt) {
    throw new Error("[daily-briefing] send entered without composed output");
  }

  // Check again at send (ADR-0103): a resume reuses old prose, and an object can close
  // after compose. No re-prompt here; downgrade or block. On resume `closedLoops` is
  // empty, so the live `integration_objects` read in the audit catches late merges.
  let body: ComposedBriefingBody = {
    subject: composed.subject,
    bodyText: composed.bodyText,
    bodyMarkdown: composed.bodyMarkdown,
  };

  const sendViolations = await auditComposedBriefing({
    userId: ctx.userId,
    composed: body,
    closedLoops: ctx.state.closedLoops,
  });

  // After a send-time downgrade, patch the row's citations to match what the user got.
  let sendSurfacedDocumentIds: string[] | null = null;

  if (sendViolations.length > 0) {
    const downgraded = downgradeOpenAsks(body, sendViolations);

    if (!downgraded) {
      await markBriefingFailed(briefingId);
      throw new Error(
        `[daily-briefing] open-ask guard blocked send: ${describeViolations(sendViolations)}`,
      );
    }

    await ctx.log(
      `send: open-ask guard downgraded payload — ${describeViolations(sendViolations)}`,
    );
    body = { ...body, ...downgraded };
    sendSurfacedDocumentIds = filterDroppedCitations(composed.citedDocumentIds, sendViolations);
  }

  // Dry run: skip Resend. The `composed` row is what to inspect.
  if (ctx.state.dryRun) {
    await ctx.log("send: skipped (dryRun)");

    return {
      kind: "done",
      state: ctx.state,
      output: {
        emailSendId: null,
        status: "dry_run" as const,
        briefingDate,
        briefingId,
        slot: ctx.state.slot,
      },
    };
  }

  const idempotencyKey = `briefing:${ctx.userId}:${briefingDate}:${ctx.state.slot}`;

  // `@alfred/mailer` owns all styling; the model only writes markdown.
  const webOrigin = serverEnv().CORS_ORIGIN.replace(/\/$/, "");

  const html = await renderBriefingEmail({
    content: body.bodyMarkdown,
    createdAt: new Date().toISOString(),
    timezone: ctx.state.timezone,
    logoUrl: emailLogoUrl(webOrigin),
    previewText: body.subject,
    // Link to the day's full briefing (ADR-0049), not to chat.
    ctaUrl: `${webOrigin}/briefings/${briefingDate}`,
    ctaLabel: "View full briefing",
  });

  const result = await send({
    userId: ctx.userId,
    kind: ctx.state.slot === "morning" ? "briefing" : "evening_recap",
    idempotencyKey,
    subject: body.subject,
    html,
    text: body.bodyText,
    payload: {
      briefingId,
      briefingDate,
      slot: ctx.state.slot,
      ...(ctx.state.timezone !== undefined ? { timezone: ctx.state.timezone } : {}),
      ...(ctx.state.reason !== undefined ? { reason: ctx.state.reason } : {}),
    },
  });

  await ctx.log(
    `send: status=${result.status} emailSendId=${result.emailSendId}` +
      (result.status === "sent" && result.providerMessageId
        ? ` resend=${result.providerMessageId}`
        : ""),
  );

  if (result.status === "failed") {
    await markBriefingFailed(briefingId);
    throw new Error(`[daily-briefing] send failed: ${result.error}`);
  }

  const gateReason =
    ctx.state.slot === "evening"
      ? "evening slot always sends"
      : ctx.state.reason !== "cron"
        ? `${ctx.state.reason} run bypasses morning suppression`
        : "demanding signal present";

  await markBriefingSent({
    briefingId,
    emailSendId: result.emailSendId,
    watermarkAt: new Date(untilIngestedAt),
    gateReason,
    ...(sendSurfacedDocumentIds
      ? {
          downgraded: {
            breakingSummary: body.bodyMarkdown,
            headline: body.subject,
            surfacedDocumentIds: sendSurfacedDocumentIds,
          },
        }
      : {}),
  });

  return {
    kind: "done",
    state: ctx.state,
    output: {
      emailSendId: result.emailSendId,
      status: result.status,
      briefingDate,
      briefingId,
      slot: ctx.state.slot,
    },
  };
}

/** Counts for the suppression gate. The raw `email` count is only the fallback for `demandingEmailCount` (#259). */
interface GatheredCounts {
  email: number;
  activity: number;
  meetings: number;
}

function gatherCounts(gather: BriefingGather): GatheredCounts {
  return {
    email: Object.values(gather.email.categories).reduce(
      (sum, items) => sum + (items?.length ?? 0),
      0,
    ),
    activity: gather.integration_activity.items.length,
    meetings: gather.calendar?.events.length ?? 0,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const trimmed = value.trim();

    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

function instructionSuppressionLogPart(items: readonly BriefingInstructionSuppression[]): string {
  if (items.length === 0) return " instruction_suppressions=0";
  const factIds = [...new Set(items.map((item) => item.factId))].join(",");

  return ` instruction_suppressions=${items.length} fact_ids=${factIds}`;
}

function pickFirstName(name: string | null): string | null {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0];

  return first || null;
}
