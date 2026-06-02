import {
  BRIEFING_WORKFLOW_SLUG,
  beginBriefing,
  briefingWorkflowInputSchema,
  composeBriefing,
  gatherBriefing,
  localDateInTimezone,
  markBriefingComposed,
  markBriefingComposing,
  markBriefingFailed,
  markBriefingGathering,
  markBriefingSent,
  markBriefingSuppressed,
  notify,
  renderBriefingEmailHtml,
  resolveBriefingPreferences,
  resolveBriefingReferences,
  type BriefingRow,
  type Workflow,
} from "@alfred/api";
import {
  assertIanaTimezone,
  briefingGatherSchema,
  type BriefingGather,
  type IanaTimezone,
} from "@alfred/contracts";
import { z } from "zod";

/**
 * Slotted briefing workflow (ADR-0048 first structural pass).
 *
 * Steps:
 *   1. gather  — create/resume the `briefings` row, collect the
 *                normalized `BriefingGather`, persist it.
 *   2. compose — run the schema-bound boss-model composer, or deterministic
 *                fallback, then persist the full briefing.
 *   3. send    — gate the composed output, then either suppress a quiet
 *                cron morning or render + dispatch via `notify()`.
 *
 * Idempotency:
 *   - `briefings` is unique on `(user_id, briefing_date, slot)`, so
 *     duplicate workflow runs for a slot either no-op when terminal or
 *     resume the existing in-progress row.
 *   - `notify()` is keyed by the same local briefing date + slot. If the
 *     email send succeeded but the workflow crashed before marking
 *     `briefings` sent, retry returns `duplicate` and the row is marked sent.
 *
 * Empty-day behavior:
 *   - Cron morning can suppress after compose and persist a quiet terminal
 *     row. Evening always sends; manual/forced runs bypass suppression.
 */

const composedOutputSchema = z.object({
  breakingSummary: z.string(),
  subject: z.string(),
  modelId: z.string(),
  composeFallback: z.boolean(),
});

const initialStateSchema = z.object({
  phase: z.literal("initial"),
  slot: z.enum(["morning", "evening"]),
  reason: z.enum(["cron", "manual", "forced"]),
  briefingDate: z.string().optional(),
});

const alreadySentStateSchema = initialStateSchema.extend({
  phase: z.literal("already_sent"),
  briefingDate: z.string(),
  timezone: z.string(),
  briefingId: z.string(),
});

const gatheredStateSchema = initialStateSchema.extend({
  phase: z.literal("gathered"),
  briefingDate: z.string(),
  timezone: z.string(),
  briefingId: z.string(),
  /** Step handoff copy; canonical copy also lives in `briefings.gather`. */
  gather: briefingGatherSchema,
});

const composedStateSchema = gatheredStateSchema.extend({
  phase: z.literal("composed"),
  composed: composedOutputSchema,
});

const stateSchema = z.discriminatedUnion("phase", [
  initialStateSchema,
  alreadySentStateSchema,
  gatheredStateSchema,
  composedStateSchema,
]);
type State = z.infer<typeof stateSchema>;

export const morningBriefingWorkflow: Workflow<State> = {
  slug: BRIEFING_WORKFLOW_SLUG,
  name: "Morning briefing",
  description:
    "Daily multi-source morning briefing — normalized gather, boss-model compose, sent via Resend (ADR-0041).",
  // Declared as cron for documentation honesty, but `next_run_at` is
  // left null at seed time so the generic workflows.tick partial index
  // skips it — `briefing.tick` (packages/api/src/modules/briefing/) owns
  // dispatch because the per-user "local hour matches delivery_hour"
  // check is per-feature. Migrating onto workflows.tick with per-user
  // schedules computed from `briefing.delivery_hour` is a follow-up.
  trigger: { kind: "cron", schedule: "0 * * * *" },
  initialStep: "gather",
  stateSchema,

  initialState(input) {
    const parsed = briefingWorkflowInputSchema.parse(input.input ?? {});
    return {
      phase: "initial",
      slot: parsed.slot,
      reason: parsed.reason,
      // When the caller pins a date (smoke script, manual UI button, the
      // cron tick), keep it. Otherwise let `gather` compute it from tz.
      briefingDate: parsed.briefingDate,
    };
  },

  steps: {
    gather: {
      id: "gather",
      async run(ctx) {
        const prefs = await resolveBriefingPreferences(ctx.userId);
        const briefingDate = ctx.state.briefingDate ?? localDateInTimezone(prefs.timezone);
        const timezone = ianaTimezone(prefs.timezone);

        const begun = await beginBriefing({
          userId: ctx.userId,
          briefingDate,
          slot: ctx.state.slot,
          timezone,
          agentRunId: ctx.runId,
        });

        if (begun.action === "skip_terminal") {
          await ctx.log(
            `gather: skip existing terminal briefing id=${begun.row.id} status=${begun.row.status}`,
          );
          return {
            kind: "done",
            state: {
              phase: "already_sent",
              slot: ctx.state.slot,
              reason: ctx.state.reason,
              briefingDate,
              timezone,
              briefingId: begun.row.id,
            },
            output: {
              briefingId: begun.row.id,
              briefingDate,
              slot: ctx.state.slot,
              status: begun.row.status,
              sendDecision: begun.row.sendDecision,
              emailSendId: begun.row.emailSendId,
            },
          };
        }

        let resumed: ReturnType<typeof resumeExistingBriefing> = null;
        try {
          resumed = resumeExistingBriefing(begun.row, ctx.state.reason);
        } catch (err) {
          await markBriefingFailed(begun.row.id);
          throw err;
        }
        if (begun.action === "resume" && resumed) {
          await ctx.log(`gather: resume existing ${begun.row.status} briefing id=${begun.row.id}`);
          return resumed;
        }

        let gather: BriefingGather;
        try {
          gather = await gatherBriefing({ userId: ctx.userId, briefingDate, timezone });
          await markBriefingGathering({ briefingId: begun.row.id, gather });
        } catch (err) {
          await markBriefingFailed(begun.row.id);
          throw err;
        }

        const counts = gatherCounts(gather);
        await ctx.log(
          `gather: id=${begun.row.id} action=${begun.action} tz=${timezone} date=${briefingDate} email=${counts.email} activity=${counts.activity} meetings=${counts.meetings}`,
        );

        return {
          kind: "next",
          state: {
            phase: "gathered",
            slot: ctx.state.slot,
            reason: ctx.state.reason,
            briefingDate,
            timezone,
            briefingId: begun.row.id,
            gather,
          },
          nextStep: "compose",
        };
      },
    },

    compose: {
      id: "compose",
      async run(ctx) {
        const state = requireGatheredState(ctx.state);
        const timezone = ianaTimezone(state.timezone);
        await markBriefingComposing(state.briefingId);

        let composed: Awaited<ReturnType<typeof composeBriefing>>;
        try {
          composed = await composeBriefing({
            userId: ctx.userId,
            briefingDate: state.briefingDate,
            slot: state.slot,
            timezone,
            gather: state.gather,
            runId: ctx.runId,
            stepId: "compose",
            idempotencyKey: ctx.idempotencyKey,
          });
          await markBriefingComposed({
            briefingId: state.briefingId,
            breakingSummary: composed.breakingSummary,
            fullBriefing: composed.fullBriefing,
            model: composed.modelId,
            composeFallback: composed.composeFallback,
          });
        } catch (err) {
          await markBriefingFailed(state.briefingId);
          throw err;
        }

        const subject = subjectLine(composed.fullBriefing.headline, state.briefingDate, timezone);
        await ctx.log(
          `compose: subject="${subject}" model=${composed.modelId} fallback=${composed.composeFallback}`,
        );

        return {
          kind: "next",
          state: {
            ...state,
            phase: "composed",
            composed: {
              breakingSummary: composed.breakingSummary,
              subject,
              modelId: composed.modelId,
              composeFallback: composed.composeFallback,
            },
          },
          nextStep: "send",
        };
      },
    },

    send: {
      id: "send",
      async run(ctx) {
        const state = requireSendState(ctx.state);
        const gate = decideSend(state);
        if (gate.decision === "suppressed") {
          await markBriefingSuppressed({
            briefingId: state.briefingId,
            watermarkAt: new Date(),
            gateReason: gate.reason,
          });
          await ctx.log(`send: suppressed reason="${gate.reason}"`);
          return {
            kind: "done",
            state,
            output: {
              briefingId: state.briefingId,
              emailSendId: null,
              status: "suppressed",
              sendDecision: "suppressed",
              gateReason: gate.reason,
              briefingDate: state.briefingDate,
              slot: state.slot,
              composeFallback: state.composed.composeFallback,
            },
          };
        }

        const resolved = resolveBriefingReferences(state.composed.breakingSummary, state.gather);
        const rendered = renderBriefingEmailHtml({ segments: resolved.segments });
        const idempotencyKey = `briefing:${ctx.userId}:${state.briefingDate}:${state.slot}`;
        const result = await notify({
          userId: ctx.userId,
          kind: state.slot === "morning" ? "briefing" : "evening_recap",
          idempotencyKey,
          subject: state.composed.subject,
          html: rendered.html,
          text: rendered.text,
          payload: {
            briefingId: state.briefingId,
            briefingDate: state.briefingDate,
            slot: state.slot,
            timezone: state.timezone,
            reason: state.reason,
            gateReason: gate.reason,
            model: state.composed.modelId,
            composeFallback: state.composed.composeFallback,
            resolvedReferences: resolved.resolved,
            unresolvedReferences: resolved.unresolved,
          },
        });

        await ctx.log(
          `send: status=${result.status} emailSendId=${result.emailSendId}` +
            (result.status === "sent" && result.providerMessageId
              ? ` resend=${result.providerMessageId}`
              : ""),
        );

        if (result.status === "failed") {
          await markBriefingFailed(state.briefingId);
          throw new Error(`[morning-briefing] send failed: ${result.error}`);
        }

        await markBriefingSent({
          briefingId: state.briefingId,
          emailSendId: result.emailSendId,
          watermarkAt: new Date(),
          gateReason: gate.reason,
        });

        return {
          kind: "done",
          state,
          output: {
            briefingId: state.briefingId,
            emailSendId: result.emailSendId,
            status: result.status,
            sendDecision: "sent",
            briefingDate: state.briefingDate,
            slot: state.slot,
            composeFallback: state.composed.composeFallback,
          },
        };
      },
    },
  },
};

function requireGatheredState(state: State): z.infer<typeof gatheredStateSchema> {
  return parseStepState(gatheredStateSchema, state, "compose", "gather output");
}

function requireSendState(state: State): z.infer<typeof composedStateSchema> {
  return parseStepState(composedStateSchema, state, "send", "composed output");
}

function parseStepState<T>(schema: z.ZodType<T>, state: State, step: string, expected: string): T {
  const parsed = schema.safeParse(state);
  if (!parsed.success) {
    throw new Error(`[morning-briefing] ${step} entered without ${expected}`);
  }
  return parsed.data;
}

function ianaTimezone(value: string): IanaTimezone {
  assertIanaTimezone(value);
  return value;
}

function resumeExistingBriefing(
  row: BriefingRow,
  reason: State["reason"],
): { kind: "next"; state: State; nextStep: "compose" | "send" } | null {
  switch (row.status) {
    case "pending":
    case "failed":
    case "sent":
    case "suppressed":
      return null;
    case "gathering":
    case "composing":
      if (!row.gather) return null;
      return {
        kind: "next",
        state: {
          phase: "gathered",
          slot: row.slot,
          reason,
          briefingDate: row.briefingDate,
          timezone: row.timezone,
          briefingId: row.id,
          gather: row.gather,
        },
        nextStep: "compose",
      };
    case "composed":
      if (!row.gather || !row.breakingSummary || !row.fullBriefing) {
        throw new Error(`[morning-briefing] composed row missing persisted output id=${row.id}`);
      }
      return {
        kind: "next",
        state: {
          phase: "composed",
          slot: row.slot,
          reason,
          briefingDate: row.briefingDate,
          timezone: row.timezone,
          briefingId: row.id,
          gather: row.gather,
          composed: {
            breakingSummary: row.breakingSummary,
            subject: subjectLine(row.fullBriefing.headline, row.briefingDate, row.timezone),
            modelId: row.model ?? "unknown",
            composeFallback: row.composeFallback,
          },
        },
        nextStep: "send",
      };
    default: {
      const _exhaustive: never = row.status;
      throw new Error(`[morning-briefing] unknown briefing status ${String(_exhaustive)}`);
    }
  }
}

function subjectLine(headline: string, briefingDate: string, timezone: IanaTimezone): string {
  const dateLabel = formatDateLabel(briefingDate, timezone);
  const trimmed = headline.trim();
  return trimmed ? `Alfred · ${dateLabel} · ${trimmed}` : `Alfred · ${dateLabel}`;
}

function decideSend(
  state: z.infer<typeof composedStateSchema>,
): { decision: "sent"; reason: string } | { decision: "suppressed"; reason: string } {
  if (state.slot === "evening") {
    return { decision: "sent", reason: "evening slot always sends" };
  }
  if (state.reason !== "cron") {
    return { decision: "sent", reason: `${state.reason} run bypasses morning suppression` };
  }

  const counts = gatherCounts(state.gather);
  if (counts.email > 0 || counts.activity > 0 || counts.meetings > 0) {
    return {
      decision: "sent",
      reason: `live signals: email=${counts.email} activity=${counts.activity} meetings=${counts.meetings}`,
    };
  }

  return {
    decision: "suppressed",
    reason: "quiet morning: no priority email, integration activity, or calendar events",
  };
}

function formatDateLabel(briefingDate: string, timezone: IanaTimezone): string {
  // briefingDate is a YYYY-MM-DD string already in the user's tz; we
  // want the long-form for the email body ("Saturday, May 2"). Build a
  // Date at noon-UTC of that day so DST doesn't bump us into a
  // neighbouring day during formatting.
  const noonUtc = new Date(`${briefingDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(noonUtc);
}

function gatherCounts(gather: BriefingGather): {
  email: number;
  activity: number;
  meetings: number;
} {
  return {
    email: Object.values(gather.email.categories).reduce(
      (sum, items) => sum + (items?.length ?? 0),
      0,
    ),
    activity: gather.integration_activity.items.length,
    meetings: gather.calendar?.events.length ?? 0,
  };
}
