import {
  gatherBriefingWithSuppressionAudit,
  instructionSuppressionLogPart,
  type BriefingInstructionSuppression,
} from "./gather";
import { inZone, parseLocalDateKey } from "@alfred/assistant/time";
import { settings } from "@alfred/assistant/settings";
import { resolveBriefingPreferences } from "./preferences";
import { fetchLatestWatermark, gatherCounts, isQuietMorning } from "./read";
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
  brokenConnectionRepairPath,
  describeBrokenConnection,
  listBrokenConnections,
  readBriefingBrokenConnections,
  type BriefingBrokenConnections,
  type BrokenConnection,
} from "@alfred/assistant/connections";
import {
  briefingClosedLoopSchema,
  briefingConnectionNoticeSchema,
  briefingLoopRelevanceSchema,
  dayShapeSchema,
  deliveryAlertSchema,
  ianaTimezoneSchema,
  mcpConnectionAlertSchema,
  type BriefingClosedLoop,
  type BriefingConnectionNotice,
  type BriefingGather,
  type BriefingLoopRelevance,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { renderBriefingEmail, type BriefingBlockRow } from "@alfred/mailer";
import { eq } from "drizzle-orm";
import { z } from "zod";
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

/** Persisted state contract. Send parses it so older queued runs receive the field defaults. */
export const dailyBriefingStateSchema = z.object({
  slot: z.enum(["morning", "evening"]),
  reason: z.enum(["cron", "manual", "forced"]),
  dryRun: z.boolean().default(false),
  briefingDate: z.string().optional(),
  timezone: ianaTimezoneSchema.optional(),
  recipientName: z.string().nullable().optional(),
  sinceIngestedAt: z.string().nullable().optional(),
  untilIngestedAt: z.string().optional(),
  briefingId: z.string().optional(),
  quietDay: z.boolean().optional(),
  closedLoops: z.array(briefingClosedLoopSchema).default([]),
  /** Non-closing relevance verdicts for the live priority loops. */
  loopRelevance: z.array(briefingLoopRelevanceSchema).default([]),
  /** The gathered day shape. Compose reads it, so the agent does not repeat the GitHub read. */
  dayShape: dayShapeSchema.optional(),
  /**
   * Connections whose delivery broke (ADR-0100 amendment 2026-10-28). Send renders one row for
   * each below the prose. Absent on a run persisted before this field; send then renders none.
   */
  brokenConnections: z.array(deliveryAlertSchema).optional(),
  /** MCP connections the user must repair (item 4 of the same amendment). Absent reads as none. */
  brokenMcpConnections: z.array(mcpConnectionAlertSchema).optional(),
  composed: z
    .object({
      subject: z.string(),
      bodyText: z.string(),
      bodyMarkdown: z.string(),
      citedDocumentIds: z.array(z.string()),
      modelId: z.string(),
      /** The composer's notice for each broken connection. A run from before this field has none. */
      connectionNotices: z.array(briefingConnectionNoticeSchema).default([]),
    })
    .optional(),
});

export type DailyBriefingOperationState = z.infer<typeof dailyBriefingStateSchema>;

export async function runDailyBriefingGather<State extends DailyBriefingOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State>> {
  // One bind for the step: the briefing preferences and the gather's weather location share its load.
  const userSettings = settings({ userId: ctx.userId });
  const prefs = await resolveBriefingPreferences(userSettings);
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

    // The gather did not run, so read the block rows now. Changed facts can contradict the saved
    // diagnosis even when the connection ids stay the same, so either change needs fresh prose.
    const broken = await readBriefingBrokenConnections(ctx.userId);
    const composedAgainst = gatheredBrokenConnections(begun.row.gather);
    const sameFacts = sameBrokenFacts(broken, composedAgainst);

    if (!sameFacts) {
      await ctx.log(
        `gather: resume composed briefing id=${begun.row.id} — broken connection facts changed ` +
          `(composed=${brokenList(composedAgainst)} now=${brokenList(broken)}); recomposing`,
      );
    }

    // Send needs the frozen window end too, so the watermark stops where the prose stops (#158).
    // A row without it (legacy) falls through to a fresh compose.
    if (breakingSummary && fullBriefing && watermarkAt && sameFacts) {
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
          brokenConnections: broken.integrations,
          brokenMcpConnections: broken.mcp,
          // `bodyText` and citations are not persisted, so reuse the markdown and no citations.
          // Use the frozen window end, not now.
          untilIngestedAt: watermarkAt.toISOString(),
          composed: {
            subject: fullBriefing.headline,
            bodyText: breakingSummary,
            bodyMarkdown: breakingSummary,
            citedDocumentIds: fullBriefing.surfacedDocumentIds ?? [],
            modelId: begun.row.model ?? "unknown",
            // The set matched above, so these notices name the connections send renders.
            connectionNotices: fullBriefing.connectionNotices ?? [],
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
      settings: userSettings,
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
  // Quiet means no `demanding` email, no activity, no meetings, and no read-proven merges
  // (ADR-0064; ADR-0062 amendment 2026-10-27). `shippedTotal` is the read's full merge count,
  // and is absent when the read failed, so the gate then behaves as before.
  // With no demand signal, fall back to the raw email count.
  const demandingEmailCount = gather.day_shape?.demandingEmailCount;

  const quietDay = isQuietMorning({
    demandingEmailCount,
    emailCount: counts.email,
    activityCount: counts.activity,
    githubMergedTotal: gather.day_shape?.shippedTotal,
    meetingCount: counts.meetings,
    brokenConnectionCount: brokenCount(gatheredBrokenConnections(gather)),
  });

  await ctx.log(
    `gather: id=${begun.row.id} action=${begun.action} tz=${timezone} date=${briefingDate} ` +
      `since=${since ? since.toISOString() : "(first run)"} until=${until.toISOString()} ` +
      `email=${counts.email} demanding=${demandingEmailCount ?? "n/a"} topBand=${gather.day_shape?.topEmailBand ?? "n/a"} ` +
      `activity=${counts.activity} meetings=${counts.meetings} broken=${brokenCount(gatheredBrokenConnections(gather))} quiet=${quietDay}${instructionSuppressionLogPart(suppressedByInstruction)}`,
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
      dayShape: gather.day_shape,
      brokenConnections: gather.broken_connections ?? [],
      brokenMcpConnections: gather.broken_mcp_connections ?? [],
    },
    nextStep: "compose",
  };
}

export async function runDailyBriefingCompose<State extends DailyBriefingOperationState>(
  ctx: StepContext<State>,
): Promise<StepResult<State>> {
  const { briefingId, untilIngestedAt, timezone } = ctx.state;

  if (!briefingId || !untilIngestedAt || !ctx.state.briefingDate || !timezone) {
    throw new Error("[daily-briefing] compose entered without gather output");
  }

  // Persisted state stores the day key as a plain string; parse it here.
  const briefingDate = parseLocalDateKey(ctx.state.briefingDate);

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
  let connectionNotices: BriefingConnectionNotice[] = [];

  // One notice per connection, written by the composer; send adds the name and the link.
  const brokenConnections = listBrokenConnections(stateBrokenConnections(ctx.state));

  try {
    const compose = async (
      openAskViolations: readonly OpenAskViolation[],
      missingConnectionNotices: readonly string[],
    ) => {
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
        dayShape: ctx.state.dayShape,
        brokenConnections,
        openAskViolations,
        missingConnectionNotices,
      });
    };

    const audit = async (draft: ComposedBriefingBody) => {
      return auditComposedBriefing({
        userId: ctx.userId,
        composed: draft,
        closedLoops: ctx.state.closedLoops,
      });
    };

    result = await compose([], []);
    body = result.briefing;

    // Open-ask guard (#1082): one aimed re-prompt, then a downgrade, then failure.
    // The guard may block or drop, never write prose. The connection-notice check shares the
    // re-prompt; a key still without a notice after it gets a bare row, not a failure.
    let violations = await audit(body);
    let missingNotices = missingNoticeKeys(brokenConnections, result.briefing.connectionNotices);

    if (violations.length > 0 || missingNotices.length > 0) {
      await ctx.log(
        `compose: draft 1 rejected — open-ask=${violations.length > 0 ? describeViolations(violations) : "ok"} ` +
          `missing-notices=${missingNotices.join(",") || "none"}`,
      );
      result = await compose(violations, missingNotices);
      body = result.briefing;
      violations = await audit(body);
      missingNotices = missingNoticeKeys(brokenConnections, result.briefing.connectionNotices);
    }

    if (missingNotices.length > 0) {
      await ctx.log(
        `compose: no connection notice for ${missingNotices.join(",")}; send shows a bare row`,
      );
    }

    connectionNotices = keptNotices(brokenConnections, result.briefing.connectionNotices);

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
        connectionNotices,
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
        connectionNotices,
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
  const state = dailyBriefingStateSchema.parse(ctx.state);
  const { composed, briefingId, briefingDate, untilIngestedAt } = state;

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
    closedLoops: state.closedLoops,
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
  if (state.dryRun) {
    await ctx.log("send: skipped (dryRun)");

    return {
      kind: "done",
      state: ctx.state,
      output: {
        emailSendId: null,
        status: "dry_run" as const,
        briefingDate,
        briefingId,
        slot: state.slot,
      },
    };
  }

  const idempotencyKey = `briefing:${ctx.userId}:${briefingDate}:${state.slot}`;

  // `@alfred/mailer` owns all styling; the model only writes markdown.
  const webOrigin = serverEnv().CORS_ORIGIN.replace(/\/$/, "");
  const apiOrigin = serverEnv().BETTER_AUTH_URL.replace(/\/$/, "");

  const blockRows = toBlockRows(
    listBrokenConnections(stateBrokenConnections(state)),
    composed.connectionNotices,
    apiOrigin,
  );

  const html = await renderBriefingEmail({
    content: body.bodyMarkdown,
    createdAt: new Date().toISOString(),
    timezone: state.timezone,
    logoUrl: emailLogoUrl(webOrigin),
    previewText: body.subject,
    // Link to the day's full briefing (ADR-0049), not to chat.
    ctaUrl: `${webOrigin}/briefings/${briefingDate}`,
    ctaLabel: "View full briefing",
    blockRows,
  });

  const result = await send({
    userId: ctx.userId,
    kind: state.slot === "morning" ? "briefing" : "evening_recap",
    idempotencyKey,
    subject: body.subject,
    html,
    text: appendBlockText(body.bodyText, blockRows),
    payload: {
      briefingId,
      briefingDate,
      slot: state.slot,
      ...(state.timezone !== undefined ? { timezone: state.timezone } : {}),
      reason: state.reason,
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
    state.slot === "evening"
      ? "evening slot always sends"
      : state.reason !== "cron"
        ? `${state.reason} run bypasses morning suppression`
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
      slot: state.slot,
    },
  };
}

/**
 * One row per broken connection, below the prose (ADR-0100 amendment 2026-10-28, revised). The
 * composer wrote the words; the code owns the name and the link, so a key with no notice still
 * gets a bare row and cannot be dropped. The link is the banner's repair route on the API origin.
 */
function toBlockRows(
  connections: readonly BrokenConnection[],
  notices: readonly BriefingConnectionNotice[],
  apiOrigin: string,
): BriefingBlockRow[] {
  const textByKey = new Map(notices.map((notice) => [notice.key, notice.text]));

  return connections.map((connection) => ({
    name: connection.name,
    text: textByKey.get(connection.key) ?? null,
    actionLabel: `Reconnect ${connection.name}`,
    actionUrl: `${apiOrigin}${brokenConnectionRepairPath(connection)}`,
  }));
}

/** The same rows, for the plain-text part. */
function appendBlockText(bodyText: string, rows: readonly BriefingBlockRow[]): string {
  if (rows.length === 0) return bodyText;

  const lines = rows.map(
    (row) => `${row.text ?? `${row.name}.`} ${row.actionLabel}: ${row.actionUrl}`,
  );

  return [bodyText, "", ...lines].join("\n");
}

/** The broken set the state carries. A run from before a field reads that field as none. */
function stateBrokenConnections(state: DailyBriefingOperationState): BriefingBrokenConnections {
  return {
    integrations: state.brokenConnections ?? [],
    mcp: state.brokenMcpConnections ?? [],
  };
}

/** Keys the composer wrote no notice for. */
function missingNoticeKeys(
  connections: readonly BrokenConnection[],
  notices: readonly BriefingConnectionNotice[],
): string[] {
  const written = new Set(notices.map((notice) => notice.key));

  return connections.map((connection) => connection.key).filter((key) => !written.has(key));
}

/** The first notice per listed key. A key the prompt did not list is dropped. */
function keptNotices(
  connections: readonly BrokenConnection[],
  notices: readonly BriefingConnectionNotice[],
): BriefingConnectionNotice[] {
  const listed = new Set(connections.map((connection) => connection.key));
  const seen = new Set<string>();

  return notices.filter((notice) => {
    if (!listed.has(notice.key) || seen.has(notice.key)) return false;

    seen.add(notice.key);

    return true;
  });
}

/** The set a gather stored. A gather from before a field reads that field as none. */
function gatheredBrokenConnections(
  gather: Pick<BriefingGather, "broken_connections" | "broken_mcp_connections"> | null | undefined,
): BriefingBrokenConnections {
  return {
    integrations: gather?.broken_connections ?? [],
    mcp: gather?.broken_mcp_connections ?? [],
  };
}

function brokenCount(broken: BriefingBrokenConnections): number {
  return broken.integrations.length + broken.mcp.length;
}

/**
 * Order-free comparison of the exact facts the composer reads. A stable connection id does not
 * imply a stable diagnosis, label, or repair: any changed fact needs fresh prose.
 */
function sameBrokenFacts(a: BriefingBrokenConnections, b: BriefingBrokenConnections): boolean {
  const left = listBrokenConnections(a);

  const right = new Map(
    listBrokenConnections(b).map((connection) => [
      connection.key,
      describeBrokenConnection(connection),
    ]),
  );

  return (
    left.length === right.size &&
    left.every((connection) => right.get(connection.key) === describeBrokenConnection(connection))
  );
}

function brokenKeys(broken: BriefingBrokenConnections): string[] {
  return listBrokenConnections(broken).map((connection) => connection.key);
}

function brokenList(broken: BriefingBrokenConnections): string {
  const keys = brokenKeys(broken);

  return keys.length === 0 ? "none" : keys.join(",");
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

function pickFirstName(name: string | null): string | null {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0];

  return first || null;
}
