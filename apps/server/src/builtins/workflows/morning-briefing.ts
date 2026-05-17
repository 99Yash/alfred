import {
  BRIEFING_WORKFLOW_SLUG,
  briefingWorkflowInputSchema,
  composeBriefing,
  gatherBriefingDigest,
  localDateInTimezone,
  notify,
  resolveBriefingPreferences,
  type Workflow,
} from "@alfred/api";
import { db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { z } from "zod";

/**
 * Morning briefing workflow (ADR-0025 #2, v1 inbox-only).
 *
 * Steps:
 *   1. gather  — resolve user's tz + delivery-hour, query last-24h
 *                triage data, persist digest + briefing-date in state.
 *   2. compose — render deterministic HTML/text from the digest.
 *   3. send    — dispatch via `notify()` with idempotency key
 *                `briefing:{userId}:{YYYY-MM-DD-in-user-tz}`.
 *
 * Idempotency:
 *   - The idempotency key is computed in `gather` (not `send`) so a
 *     retry of `send` re-uses the same key even if the cron tick rolls
 *     into a new local day. This matters when the workflow is queued
 *     near a tz boundary.
 *   - `notify()` short-circuits on duplicate keys via the unique index
 *     on `email_sends`, so re-runs cost nothing.
 *
 * Empty-day behavior:
 *   - We still send. An empty-inbox briefing reads as "you're clear"
 *     and confirms the system is alive; suppressing it would feel like
 *     a missed delivery.
 */

const stateSchema = z.object({
  reason: z.enum(["cron", "manual", "forced"]),
  /** Computed in step 1; consumed by step 3. */
  briefingDate: z.string().optional(),
  timezone: z.string().optional(),
  recipientName: z.string().nullable().optional(),
  /** Computed in step 1; consumed by step 2. Stored as ISO so JSON state survives serialization. */
  digestJson: z.string().optional(),
  /** Computed in step 2; consumed by step 3. */
  composed: z
    .object({
      subject: z.string(),
      html: z.string(),
      text: z.string(),
    })
    .optional(),
});
type State = z.infer<typeof stateSchema>;

interface SerializedDigest {
  windowStart: string;
  windowEnd: string;
  buckets: Record<string, unknown[]>;
  suppressedCounts: Record<string, number>;
  totalPriority: number;
  totalSuppressed: number;
}

export const morningBriefingWorkflow: Workflow<State> = {
  slug: BRIEFING_WORKFLOW_SLUG,
  name: "Morning briefing",
  description:
    "Daily inbox-only morning briefing — last-24h priority email by triage tag, sent via Resend (ADR-0025 #2).",
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

        const digest = await gatherBriefingDigest({ userId: ctx.userId });

        // Surface for ops: easy to grep for "0/0" empty days vs noisy days.
        await ctx.log(
          `gather: tz=${prefs.timezone} date=${briefingDate} priority=${digest.totalPriority} suppressed=${digest.totalSuppressed}`,
        );

        const userRows = await db()
          .select({ name: user.name, email: user.email })
          .from(user)
          .where(eq(user.id, ctx.userId));
        const u = userRows[0];
        const recipientName = pickFirstName(u?.name ?? null) ?? null;

        // Serialise the digest into state. Dates → ISO so JSON
        // round-trip through the run-state column doesn't lose them.
        const digestJson = JSON.stringify({
          windowStart: digest.windowStart.toISOString(),
          windowEnd: digest.windowEnd.toISOString(),
          buckets: Object.fromEntries(
            Object.entries(digest.buckets).map(([k, items]) => [
              k,
              items.map((i) => ({
                ...i,
                authoredAt: i.authoredAt ? i.authoredAt.toISOString() : null,
              })),
            ]),
          ),
          suppressedCounts: digest.suppressedCounts,
          totalPriority: digest.totalPriority,
          totalSuppressed: digest.totalSuppressed,
        } satisfies SerializedDigest);

        return {
          kind: "next",
          state: {
            ...ctx.state,
            briefingDate,
            timezone: prefs.timezone,
            recipientName,
            digestJson,
          },
          nextStep: "compose",
        };
      },
    },

    compose: {
      id: "compose",
      async run(ctx) {
        if (!ctx.state.digestJson || !ctx.state.briefingDate || !ctx.state.timezone) {
          throw new Error("[morning-briefing] compose entered without gather output");
        }
        const parsed = JSON.parse(ctx.state.digestJson) as SerializedDigest;
        const digest = {
          windowStart: new Date(parsed.windowStart),
          windowEnd: new Date(parsed.windowEnd),
          buckets: Object.fromEntries(
            Object.entries(parsed.buckets).map(([k, items]) => [
              k,
              (items as Array<Record<string, unknown>>).map((i) => ({
                ...i,
                authoredAt:
                  typeof i.authoredAt === "string" ? new Date(i.authoredAt) : null,
              })),
            ]),
          ) as never,
          suppressedCounts: parsed.suppressedCounts as never,
          totalPriority: parsed.totalPriority,
          totalSuppressed: parsed.totalSuppressed,
        };

        const dateLabel = formatDateLabel(ctx.state.briefingDate, ctx.state.timezone);
        const composed = composeBriefing({
          digest,
          recipientName: ctx.state.recipientName,
          dateLabel,
        });

        await ctx.log(`compose: subject="${composed.subject}"`);

        return {
          kind: "next",
          state: { ...ctx.state, composed },
          nextStep: "send",
        };
      },
    },

    send: {
      id: "send",
      async run(ctx) {
        if (!ctx.state.composed || !ctx.state.briefingDate) {
          throw new Error("[morning-briefing] send entered without composed output");
        }
        const idempotencyKey = `briefing:${ctx.userId}:${ctx.state.briefingDate}`;
        const result = await notify({
          userId: ctx.userId,
          kind: "briefing",
          idempotencyKey,
          subject: ctx.state.composed.subject,
          html: ctx.state.composed.html,
          text: ctx.state.composed.text,
          payload: {
            briefingDate: ctx.state.briefingDate,
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
          throw new Error(`[morning-briefing] send failed: ${result.error}`);
        }

        return {
          kind: "done",
          state: ctx.state,
          output: {
            emailSendId: result.emailSendId,
            status: result.status,
            briefingDate: ctx.state.briefingDate,
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

function formatDateLabel(briefingDate: string, timezone: string): string {
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
