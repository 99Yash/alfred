import {
  DAILY_BRIEFING_WORKFLOW_SLUG,
  dailyBriefingWorkflowInputSchema,
  fetchLatestWatermark,
  localDateInTimezone,
  notify,
  recordBriefingRun,
  resolveBriefingPreferences,
  type Workflow,
} from "@alfred/api";
import { db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { renderBriefingEmail } from "@alfred/mailer";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { runBriefingAgent } from "../agents/briefing/agent";

/**
 * Daily briefing workflow — LLM-composed, two slots ('morning' |
 * 'evening'), watermark-driven delta + prior-briefing memory. Replaces
 * the m10 deterministic morning-briefing once smoke validates against
 * Dimension's sample outputs.
 *
 * Steps:
 *   1. gather   — resolve tz + first name, freeze the watermark window
 *                 (since = last composed run's watermark for this slot;
 *                 until = now), persist briefing date.
 *   2. compose  — run the briefing agent with bounded tools; capture
 *                 the dump_briefing output.
 *   3. persist  — insert briefing_runs row at status='composed'. The
 *                 watermark is anchored on this row for future runs.
 *   4. send     — notify() with the slot-appropriate idempotency key
 *                 (briefing: for morning, recap: for evening, both
 *                 segmented by user + date in user tz).
 *
 * Why persist before send: the agent's compose work is the expensive
 * piece. If notify() fails (Resend down), we don't lose the body — a
 * future smoke or settings-page resend can pick it back up from
 * briefing_runs without re-burning the LLM call.
 *
 * Why idempotency-key namespaces differ by slot: `email_sends` already
 * documents both `briefing:` and `recap:` conventions (ADR-0020). Keeps
 * the unique index from short-circuiting an evening send because that
 * day's morning already sent.
 */

const stateSchema = z.object({
  slot: z.enum(["morning", "evening"]),
  reason: z.enum(["cron", "manual", "forced"]),
  /**
   * When true, persist briefing_runs as `status='dry_run'` and skip the
   * Resend send. Watermark stays unconsumed so a later real run sees the
   * same delta. Drives the smoke runner's `--no-send` flag.
   */
  dryRun: z.boolean().default(false),
  briefingDate: z.string().optional(),
  timezone: z.string().optional(),
  recipientName: z.string().nullable().optional(),
  /** ISO instant. Set in `gather`; consumed by `compose` + `persist`. */
  sinceIngestedAt: z.string().nullable().optional(),
  /** ISO instant. Frozen in `gather`. */
  untilIngestedAt: z.string().optional(),
  composed: z
    .object({
      subject: z.string(),
      bodyText: z.string(),
      bodyMarkdown: z.string(),
      citedDocumentIds: z.array(z.string()),
      modelId: z.string(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      steps: z.number(),
    })
    .optional(),
  /** Briefing-runs row id, set after `persist`. */
  briefingRunId: z.string().optional(),
});
type State = z.infer<typeof stateSchema>;

export const dailyBriefingWorkflow: Workflow<State> = {
  slug: DAILY_BRIEFING_WORKFLOW_SLUG,
  name: "Daily briefing (LLM-composed)",
  description:
    "Watermarked LLM-composed daily briefing in two slots (morning, evening). Reads its own prior briefings as memory. Replaces m10 morning-briefing once smoke validates.",
  // Same posture as morning-briefing: declared as cron for honesty,
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

        const userRows = await db()
          .select({ name: user.name, email: user.email })
          .from(user)
          .where(eq(user.id, ctx.userId));
        const u = userRows[0];
        const recipientName = pickFirstName(u?.name ?? null);

        const since = await fetchLatestWatermark({ userId: ctx.userId, slot: ctx.state.slot });
        const until = new Date();

        await ctx.log(
          `gather: slot=${ctx.state.slot} tz=${prefs.timezone} date=${briefingDate} ` +
            `since=${since ? since.toISOString() : "(first run)"} until=${until.toISOString()}`,
        );

        return {
          kind: "next",
          state: {
            ...ctx.state,
            briefingDate,
            timezone: prefs.timezone,
            recipientName,
            sinceIngestedAt: since ? since.toISOString() : null,
            untilIngestedAt: until.toISOString(),
          },
          nextStep: "compose",
        };
      },
    },

    compose: {
      id: "compose",
      async run(ctx) {
        if (!ctx.state.untilIngestedAt) {
          throw new Error("[daily-briefing] compose entered without gather output");
        }
        const since = ctx.state.sinceIngestedAt ? new Date(ctx.state.sinceIngestedAt) : null;
        const until = new Date(ctx.state.untilIngestedAt);

        const result = await runBriefingAgent({
          userId: ctx.userId,
          slot: ctx.state.slot,
          recipientFirstName: ctx.state.recipientName ?? null,
          sinceIngestedAt: since,
          untilIngestedAt: until,
          runId: ctx.runId,
          stepId: "compose",
        });

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
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              steps: result.steps,
            },
          },
          nextStep: "persist",
        };
      },
    },

    persist: {
      id: "persist",
      async run(ctx) {
        if (!ctx.state.composed || !ctx.state.untilIngestedAt || !ctx.state.briefingDate) {
          throw new Error("[daily-briefing] persist entered without composed output");
        }

        const row = await recordBriefingRun({
          userId: ctx.userId,
          slot: ctx.state.slot,
          briefingDate: ctx.state.briefingDate,
          watermarkAt: new Date(ctx.state.untilIngestedAt),
          status: ctx.state.dryRun ? "dry_run" : "composed",
          subject: ctx.state.composed.subject,
          bodyText: ctx.state.composed.bodyText,
          bodyMarkdown: ctx.state.composed.bodyMarkdown,
          agentRunId: ctx.runId,
          modelId: ctx.state.composed.modelId,
          inputTokens: ctx.state.composed.inputTokens,
          outputTokens: ctx.state.composed.outputTokens,
          payload: {
            citedDocumentIds: ctx.state.composed.citedDocumentIds,
            steps: ctx.state.composed.steps,
            sinceIngestedAt: ctx.state.sinceIngestedAt,
            reason: ctx.state.reason,
            dryRun: ctx.state.dryRun,
          },
        });

        await ctx.log(
          `persist: briefingRunId=${row.id} status=${ctx.state.dryRun ? "dry_run" : "composed"}`,
        );

        return {
          kind: "next",
          state: { ...ctx.state, briefingRunId: row.id },
          nextStep: "send",
        };
      },
    },

    send: {
      id: "send",
      async run(ctx) {
        if (!ctx.state.composed || !ctx.state.briefingDate) {
          throw new Error("[daily-briefing] send entered without composed output");
        }

        // Dry run short-circuit: skip Resend entirely. The briefing_runs
        // row from `persist` is the inspection artifact; output mirrors a
        // real send so the smoke script doesn't need a special path.
        if (ctx.state.dryRun) {
          await ctx.log("send: skipped (dryRun)");
          return {
            kind: "done",
            state: ctx.state,
            output: {
              emailSendId: null,
              status: "dry_run" as const,
              briefingDate: ctx.state.briefingDate,
              briefingRunId: ctx.state.briefingRunId,
              slot: ctx.state.slot,
            },
          };
        }

        const prefix = ctx.state.slot === "morning" ? "briefing" : "recap";
        const idempotencyKey = `${prefix}:${ctx.userId}:${ctx.state.briefingDate}`;

        // Render the agent's markdown body into the polished email shell.
        // The template (`@alfred/mailer`) owns all styling; the model only
        // ever produces prose markdown.
        const webOrigin = serverEnv().CORS_ORIGIN.replace(/\/$/, "");
        const html = await renderBriefingEmail({
          content: ctx.state.composed.bodyMarkdown,
          createdAt: new Date().toISOString(),
          timezone: ctx.state.timezone,
          // Raster PNG, not SVG: Gmail/Outlook drop inline SVG <img> to alt text.
          logoUrl: `${webOrigin}/images/logo/alfred-logo-email.png`,
          previewText: ctx.state.composed.subject,
          ctaUrl: ctx.state.slot === "morning" ? `${webOrigin}/chat/new` : undefined,
        });

        const result = await notify({
          userId: ctx.userId,
          kind: ctx.state.slot === "morning" ? "briefing" : "evening_recap",
          idempotencyKey,
          subject: ctx.state.composed.subject,
          html,
          text: ctx.state.composed.bodyText,
          payload: {
            briefingDate: ctx.state.briefingDate,
            slot: ctx.state.slot,
            timezone: ctx.state.timezone,
            reason: ctx.state.reason,
            briefingRunId: ctx.state.briefingRunId,
          },
        });

        await ctx.log(
          `send: status=${result.status} emailSendId=${result.emailSendId}` +
            (result.status === "sent" && result.providerMessageId
              ? ` resend=${result.providerMessageId}`
              : ""),
        );

        if (result.status === "failed") {
          throw new Error(`[daily-briefing] send failed: ${result.error}`);
        }

        return {
          kind: "done",
          state: ctx.state,
          output: {
            emailSendId: result.emailSendId,
            status: result.status,
            briefingDate: ctx.state.briefingDate,
            briefingRunId: ctx.state.briefingRunId,
            slot: ctx.state.slot,
          },
        };
      },
    },
  },
};

function pickFirstName(name: string | null): string | null {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0];
  return first || null;
}
