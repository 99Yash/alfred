import {
  DAILY_BRIEFING_WORKFLOW_SLUG,
  beginBriefing,
  dailyBriefingWorkflowInputSchema,
  fetchLatestWatermark,
  gatherBriefingWithSuppressionAudit,
  localDateInTimezone,
  markBriefingComposed,
  markBriefingComposing,
  markBriefingFailed,
  markBriefingGathering,
  markBriefingSent,
  markBriefingSuppressed,
  notify,
  resolveBriefingPreferences,
  type BriefingInstructionSuppression,
  type Workflow,
} from "@alfred/api";
import { assertIanaTimezone, type BriefingGather, type IanaTimezone } from "@alfred/contracts";
import { db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { renderBriefingEmail } from "@alfred/mailer";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { runBriefingAgent } from "../agents/briefing/agent";

/**
 * Daily briefing workflow — LLM-composed prose, two slots ('morning' |
 * 'evening'), watermark-driven delta + prior-briefing memory (ADR-0048).
 * The single live briefing path: it writes the canonical `briefings`
 * table via the `store.ts` state machine, so the in-app surface
 * (ADR-0049) and the rail chip reflect it.
 *
 * Steps:
 *   1. gather   — begin/resume the `briefings` row, freeze the watermark
 *                 window (since = last consumed run's watermark for this
 *                 slot; until = now), run the deterministic structured
 *                 gather (cheap DB reads) for the suppression signal +
 *                 surface payload, and persist it (`markBriefingGathering`).
 *   2. compose  — quiet cron mornings suppress here *without* an LLM call.
 *                 Otherwise run the briefing agent and persist the prose
 *                 onto the row (`markBriefingComposed`).
 *   3. send     — render markdown → email shell, `notify()` with the
 *                 slot-scoped idempotency key, then `markBriefingSent`.
 *
 * Content mapping (prose model → `briefings` schema): the agent emits a
 * single markdown body, so `breaking_summary` ← `bodyMarkdown` (the
 * column is unbounded `text`; the 2000-char cap lives only on the unused
 * structured `briefingComposerSchema`) and `full_briefing` ←
 * `{ headline: subject, sections: [] }`. The surface renders
 * `breaking_summary` as markdown and treats `sections`/`sourcePanels` as
 * optional detail (see `briefing-slot.tsx`).
 *
 * Suppression (ADR-0048): the morning slot is discretionary — a quiet
 * cron morning suppresses; evening always sends; manual/forced runs
 * (e.g. the rail "Generate briefing" button) bypass suppression. "Quiet"
 * reuses the old gate's rule: no priority email, no integration activity,
 * and no calendar events in the window.
 */

const stateSchema = z.object({
  slot: z.enum(["morning", "evening"]),
  reason: z.enum(["cron", "manual", "forced"]),
  /**
   * When true, skip the Resend send and don't write a terminal row. The
   * watermark stays unconsumed so a later real run sees the same delta.
   * Drives the smoke runner's `--no-send` flag.
   */
  dryRun: z.boolean().default(false),
  briefingDate: z.string().optional(),
  timezone: z.string().optional(),
  recipientName: z.string().nullable().optional(),
  /** ISO instant. Set in `gather`; consumed by `compose` + `send`. */
  sinceIngestedAt: z.string().nullable().optional(),
  /** ISO instant. Frozen in `gather`; anchors the terminal watermark. */
  untilIngestedAt: z.string().optional(),
  /** `briefings` row id, set in `gather`. */
  briefingId: z.string().optional(),
  /** No priority email, integration activity, or calendar events in window. */
  quietDay: z.boolean().optional(),
  composed: z
    .object({
      subject: z.string(),
      bodyText: z.string(),
      bodyMarkdown: z.string(),
      citedDocumentIds: z.array(z.string()),
      modelId: z.string(),
    })
    .optional(),
});
type State = z.infer<typeof stateSchema>;

export const dailyBriefingWorkflow: Workflow<State> = {
  slug: DAILY_BRIEFING_WORKFLOW_SLUG,
  name: "Daily briefing (LLM-composed)",
  description:
    "Watermarked LLM-composed daily briefing in two slots (morning, evening). Reads its own prior briefings as memory. Writes the canonical `briefings` table (ADR-0048).",
  // Same posture as the old morning-briefing: declared as cron for honesty,
  // but actual dispatch goes through briefing-cron's per-user fan-out
  // (briefing.tick), not the generic workflows.tick. `next_run_at`
  // stays null at seed time.
  trigger: { kind: "cron", schedule: "0 * * * *" },
  initialStep: "gather",
  stateSchema,

  initialState(input) {
    const parsed = dailyBriefingWorkflowInputSchema.parse(input.input ?? {});
    return {
      slot: parsed.slot,
      reason: parsed.reason,
      dryRun: parsed.dryRun,
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

        // A terminal row already exists for this (user, date, slot) — the
        // unique index is the no-double-send guard. Return its outcome
        // rather than recomposing.
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

        const userRows = await db()
          .select({ name: user.name })
          .from(user)
          .where(eq(user.id, ctx.userId));
        const recipientName = pickFirstName(userRows[0]?.name ?? null);

        const since = await fetchLatestWatermark({ userId: ctx.userId, slot: ctx.state.slot });
        const until = new Date();

        let gather: BriefingGather;
        let suppressedByInstruction: BriefingInstructionSuppression[] = [];
        try {
          // Deterministic structured gather over the same watermark window the
          // agent composes from. Cheap (DB reads against email_triage +
          // calendar/activity) — it feeds the suppression signal and the
          // surface's `gather` payload; the agent still authors the prose.
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
          await markBriefingGathering({ briefingId: begun.row.id, gather });
        } catch (err) {
          await markBriefingFailed(begun.row.id);
          throw err;
        }

        const counts = gatherCounts(gather);
        const quietDay = counts.email === 0 && counts.activity === 0 && counts.meetings === 0;

        await ctx.log(
          `gather: id=${begun.row.id} action=${begun.action} tz=${timezone} date=${briefingDate} ` +
            `since=${since ? since.toISOString() : "(first run)"} until=${until.toISOString()} ` +
            `email=${counts.email} activity=${counts.activity} meetings=${counts.meetings} quiet=${quietDay}${instructionSuppressionLogPart(suppressedByInstruction)}`,
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
          },
          nextStep: "compose",
        };
      },
    },

    compose: {
      id: "compose",
      async run(ctx) {
        const { briefingId, untilIngestedAt, briefingDate } = ctx.state;
        if (!briefingId || !untilIngestedAt || !briefingDate) {
          throw new Error("[daily-briefing] compose entered without gather output");
        }

        // Discretionary morning: a quiet cron morning suppresses *before*
        // the agent runs, so a nothing-to-report day costs no LLM call.
        // Evening always sends; manual/forced bypass.
        if (ctx.state.slot === "morning" && ctx.state.reason === "cron" && ctx.state.quietDay) {
          const gateReason =
            "quiet morning: no priority email, integration activity, or calendar events";
          if (!ctx.state.dryRun) {
            await markBriefingSuppressed({
              briefingId,
              watermarkAt: new Date(untilIngestedAt),
              gateReason,
            });
          }
          await ctx.log(
            `compose: suppressed (${gateReason})${ctx.state.dryRun ? " [dryRun]" : ""}`,
          );
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
        try {
          result = await runBriefingAgent({
            userId: ctx.userId,
            slot: ctx.state.slot,
            recipientFirstName: ctx.state.recipientName ?? null,
            sinceIngestedAt: since,
            untilIngestedAt: until,
            runId: ctx.runId,
            stepId: "compose",
          });
          await markBriefingComposed({
            briefingId,
            // Prose body → breaking_summary; headline ← subject; no structured
            // sections (the model emits one markdown body, not buckets).
            breakingSummary: result.briefing.bodyMarkdown,
            fullBriefing: { headline: result.briefing.subject, sections: [] },
            model: result.modelId,
            composeFallback: false,
          });
        } catch (err) {
          await markBriefingFailed(briefingId);
          throw err;
        }

        await ctx.log(
          `compose: steps=${result.steps} model=${result.modelId} ` +
            `in=${result.usage.inputTokens ?? 0} out=${result.usage.outputTokens ?? 0} ` +
            `subject="${result.briefing.subject}"`,
        );

        return {
          kind: "next",
          state: {
            ...ctx.state,
            composed: {
              subject: result.briefing.subject,
              bodyText: result.briefing.bodyText,
              bodyMarkdown: result.briefing.bodyMarkdown,
              citedDocumentIds: result.briefing.citedDocumentIds,
              modelId: result.modelId,
            },
          },
          nextStep: "send",
        };
      },
    },

    send: {
      id: "send",
      async run(ctx) {
        const { composed, briefingId, briefingDate, untilIngestedAt } = ctx.state;
        if (!composed || !briefingId || !briefingDate || !untilIngestedAt) {
          throw new Error("[daily-briefing] send entered without composed output");
        }

        // Dry run short-circuit: skip Resend. The `composed` briefings row
        // from `compose` is the inspection artifact; output mirrors a real
        // send so the smoke script doesn't need a special path.
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

        // Render the agent's markdown body into the polished email shell.
        // The template (`@alfred/mailer`) owns all styling; the model only
        // ever produces prose markdown.
        const webOrigin = serverEnv().CORS_ORIGIN.replace(/\/$/, "");
        const html = await renderBriefingEmail({
          content: composed.bodyMarkdown,
          createdAt: new Date().toISOString(),
          timezone: ctx.state.timezone,
          // Raster PNG, not SVG: Gmail/Outlook drop inline SVG <img> to alt text.
          logoUrl: `${webOrigin}/images/logo/alfred-logo-email.png`,
          previewText: composed.subject,
          // Both slots get the CTA, pointed at the full briefing for that day
          // (`/briefings/{YYYY-MM-DD}`, ADR-0049) rather than the chat surface.
          ctaUrl: `${webOrigin}/briefings/${briefingDate}`,
          ctaLabel: "View full briefing",
        });

        const result = await notify({
          userId: ctx.userId,
          kind: ctx.state.slot === "morning" ? "briefing" : "evening_recap",
          idempotencyKey,
          subject: composed.subject,
          html,
          text: composed.bodyText,
          payload: {
            briefingId,
            briefingDate,
            slot: ctx.state.slot,
            timezone: ctx.state.timezone,
            reason: ctx.state.reason,
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
              : "live signals present";
        await markBriefingSent({
          briefingId,
          emailSendId: result.emailSendId,
          watermarkAt: new Date(untilIngestedAt),
          gateReason,
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
      },
    },
  },
};

/**
 * Live-signal counts for the suppression gate. `email.categories` holds
 * only priority categories (gatherBriefing buckets fyi/newsletter out),
 * so a non-zero email count means a priority email landed in the window.
 */
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

function instructionSuppressionLogPart(items: readonly BriefingInstructionSuppression[]): string {
  if (items.length === 0) return " instruction_suppressions=0";
  const factIds = [...new Set(items.map((item) => item.factId))].join(",");
  return ` instruction_suppressions=${items.length} fact_ids=${factIds}`;
}

function ianaTimezone(value: string): IanaTimezone {
  assertIanaTimezone(value);
  return value;
}

function pickFirstName(name: string | null): string | null {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0];
  return first || null;
}
