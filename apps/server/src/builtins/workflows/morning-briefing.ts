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
  notify,
  renderBriefingEmailHtml,
  resolveBriefingPreferences,
  resolveBriefingReferences,
  type Workflow,
} from "@alfred/api";
import { assertIanaTimezone, type BriefingGather, type IanaTimezone } from "@alfred/contracts";
import { z } from "zod";

/**
 * Morning briefing workflow (ADR-0041, v2 backend cutover).
 *
 * Steps:
 *   1. gather  — create/resume the `briefings` row, collect the
 *                normalized `BriefingGather`, persist it.
 *   2. compose — run the schema-bound boss-model composer, or deterministic
 *                fallback, then persist the full briefing.
 *   3. send    — render the breaking summary with resolved references and
 *                dispatch via `notify()`.
 *
 * Idempotency:
 *   - `briefings` is unique on `(user_id, briefing_date)`, so duplicate
 *     workflow runs for a day either no-op when already sent or resume
 *     the existing in-progress row.
 *   - `notify()` is keyed by the same local briefing date. If the email
 *     send succeeded but the workflow crashed before marking `briefings`
 *     sent, retry returns `duplicate` and the row is marked sent.
 *
 * Empty-day behavior:
 *   - We still send. The fallback and composer both render an honest empty
 *     day instead of suppressing delivery.
 */

const stateSchema = z.object({
  reason: z.enum(["cron", "manual", "forced"]),
  briefingDate: z.string().optional(),
  timezone: z.string().optional(),
  briefingId: z.string().optional(),
  /** Serialized `BriefingGather`; canonical copy also lives in `briefings.gather`. */
  gatherJson: z.string().optional(),
  composed: z
    .object({
      breakingSummary: z.string(),
      subject: z.string(),
      modelId: z.string(),
      composeFallback: z.boolean(),
    })
    .optional(),
});
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
          timezone,
        });

        if (begun.action === "skip_sent") {
          await ctx.log(`gather: skip existing sent briefing id=${begun.row.id}`);
          return {
            kind: "done",
            state: {
              ...ctx.state,
              briefingDate,
              timezone,
              briefingId: begun.row.id,
            },
            output: {
              briefingId: begun.row.id,
              briefingDate,
              status: "already_sent",
              emailSendId: begun.row.emailSendId,
            },
          };
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
            ...ctx.state,
            briefingDate,
            timezone,
            briefingId: begun.row.id,
            gatherJson: JSON.stringify(gather),
          },
          nextStep: "compose",
        };
      },
    },

    compose: {
      id: "compose",
      async run(ctx) {
        if (
          !ctx.state.briefingId ||
          !ctx.state.gatherJson ||
          !ctx.state.briefingDate ||
          !ctx.state.timezone
        ) {
          throw new Error("[morning-briefing] compose entered without gather output");
        }
        const gather = parseGather(ctx.state.gatherJson);
        const timezone = ianaTimezone(ctx.state.timezone);
        await markBriefingComposing(ctx.state.briefingId);

        let composed: Awaited<ReturnType<typeof composeBriefing>>;
        try {
          composed = await composeBriefing({
            userId: ctx.userId,
            briefingDate: ctx.state.briefingDate,
            timezone,
            gather,
            runId: ctx.runId,
            stepId: "compose",
            idempotencyKey: ctx.idempotencyKey,
          });
          await markBriefingComposed({
            briefingId: ctx.state.briefingId,
            breakingSummary: composed.breakingSummary,
            fullBriefing: composed.fullBriefing,
            model: composed.modelId,
            composeFallback: composed.composeFallback,
          });
        } catch (err) {
          await markBriefingFailed(ctx.state.briefingId);
          throw err;
        }

        const subject = subjectLine(
          composed.fullBriefing.headline,
          ctx.state.briefingDate,
          timezone,
        );
        await ctx.log(
          `compose: subject="${subject}" model=${composed.modelId} fallback=${composed.composeFallback}`,
        );

        return {
          kind: "next",
          state: {
            ...ctx.state,
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
        if (
          !ctx.state.composed ||
          !ctx.state.briefingDate ||
          !ctx.state.briefingId ||
          !ctx.state.gatherJson
        ) {
          throw new Error("[morning-briefing] send entered without composed output");
        }
        const gather = parseGather(ctx.state.gatherJson);
        const resolved = resolveBriefingReferences(ctx.state.composed.breakingSummary, gather);
        const rendered = renderBriefingEmailHtml({ segments: resolved.segments });
        const idempotencyKey = `briefing:${ctx.userId}:${ctx.state.briefingDate}`;
        const result = await notify({
          userId: ctx.userId,
          kind: "briefing",
          idempotencyKey,
          subject: ctx.state.composed.subject,
          html: rendered.html,
          text: rendered.text,
          payload: {
            briefingId: ctx.state.briefingId,
            briefingDate: ctx.state.briefingDate,
            timezone: ctx.state.timezone,
            reason: ctx.state.reason,
            model: ctx.state.composed.modelId,
            composeFallback: ctx.state.composed.composeFallback,
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
          await markBriefingFailed(ctx.state.briefingId);
          throw new Error(`[morning-briefing] send failed: ${result.error}`);
        }

        await markBriefingSent({
          briefingId: ctx.state.briefingId,
          emailSendId: result.emailSendId,
        });

        return {
          kind: "done",
          state: ctx.state,
          output: {
            briefingId: ctx.state.briefingId,
            emailSendId: result.emailSendId,
            status: result.status,
            briefingDate: ctx.state.briefingDate,
            composeFallback: ctx.state.composed.composeFallback,
          },
        };
      },
    },
  },
};

function parseGather(value: string): BriefingGather {
  return JSON.parse(value) as BriefingGather;
}

function ianaTimezone(value: string): IanaTimezone {
  assertIanaTimezone(value);
  return value;
}

function subjectLine(headline: string, briefingDate: string, timezone: IanaTimezone): string {
  const dateLabel = formatDateLabel(briefingDate, timezone);
  const trimmed = headline.trim();
  return trimmed ? `Alfred · ${dateLabel} · ${trimmed}` : `Alfred · ${dateLabel}`;
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
