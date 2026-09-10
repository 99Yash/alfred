import { integrationDisplayName, type BriefingDegradedSource } from "@alfred/contracts";
import { db } from "@alfred/db";
import { briefings } from "@alfred/db/schemas";
import { and, desc, eq, gt } from "drizzle-orm";
import {
  readDegradedInboundSources,
  type DegradedInboundSource,
} from "@alfred/assistant/connections/ingress";
import { webOrigin } from "@alfred/assistant/settings";

/**
 * The scheduled inbound-health reconciler for the briefing (#1035).
 *
 * A source that produces deliveries only while it is healthy cannot report its
 * own silence: it sends nothing when it breaks, so no push signal exists to
 * react to. Only a pull check answers the question, and the briefing cron is
 * the schedule that already runs and already reads stored credentials. The
 * gather step calls {@link gatherDegradedSources}; the compose step appends
 * {@link formatDegradedSources} after the agent's prose.
 *
 * The verdict itself stays the descriptor's own — this module reads
 * `readDegradedInboundSources` and never restates a per-source rule. What it
 * adds is three things a descriptor cannot know: which sources a recent
 * briefing already reported, how the recovery reads as a sentence, and where
 * the user goes to act on it.
 */

/**
 * How long one report silences the next one for the same source.
 *
 * A briefing runs twice a day, so a short window would put the same line in
 * front of the user every morning and every evening until the credential is
 * repaired. A week is long enough that the line stays news, and short enough
 * that a subscription broken in the background is raised again rather than
 * forgotten.
 *
 * Accepted residual: recovery is not observed. A source that breaks, is
 * repaired, and breaks again inside the window is reported once, not twice.
 */
const DEGRADED_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

/** Only a handful of delivered briefings can fall inside the repeat window. */
const DEGRADED_LOOKBACK_LIMIT = 30;

export interface GatherDegradedSourcesArgs {
  userId: string;
  /** Upper bound of the repeat window — pass the run's frozen "until". */
  before: Date;
}

/**
 * The degraded inbound sources this run should render, already resolved for
 * display. Empty on a good day, and empty for a source a recent briefing
 * already reported, so the caller can treat a non-empty result as "there is a
 * line to print".
 */
export async function gatherDegradedSources(
  args: GatherDegradedSourcesArgs,
): Promise<BriefingDegradedSource[]> {
  const degraded = await readDegradedInboundSources(args.userId);
  if (degraded.length === 0) return [];

  const alreadyReported = await listRecentlyReportedSources(args);
  return degraded
    .filter((entry) => !alreadyReported.has(entry.slug))
    .map((entry) => describeDegradedSource(entry));
}

/**
 * The source slugs a delivered briefing already reported inside the repeat
 * window. Read from the persisted gather payloads of `sent` rows only: a
 * suppressed or failed run printed no line, so it owes the user a report.
 */
async function listRecentlyReportedSources(
  args: GatherDegradedSourcesArgs,
): Promise<ReadonlySet<string>> {
  const since = new Date(args.before.getTime() - DEGRADED_REPEAT_MS);
  const rows = await db()
    .select({ gather: briefings.gather })
    .from(briefings)
    .where(
      and(
        eq(briefings.userId, args.userId),
        eq(briefings.status, "sent"),
        gt(briefings.createdAt, since),
      ),
    )
    .orderBy(desc(briefings.createdAt))
    .limit(DEGRADED_LOOKBACK_LIMIT);

  const reported = new Set<string>();
  for (const row of rows) {
    for (const entry of row.gather?.degraded_sources ?? []) {
      reported.add(entry.source);
    }
  }
  return reported;
}

/**
 * Resolve one verdict into the line's parts. The recovery switch is exhaustive,
 * so a new recovery kind fails to compile here rather than rendering a source
 * the user cannot act on.
 */
function describeDegradedSource(entry: DegradedInboundSource): BriefingDegradedSource {
  const label = integrationDisplayName(entry.slug);
  const reason = withoutTrailingPeriod(entry.reason);
  switch (entry.recovery.kind) {
    case "connect": {
      const integration = entry.recovery.integration;
      return {
        source: entry.slug,
        label,
        reason,
        action: `Reconnect ${integrationDisplayName(integration)}`,
        actionUrl: `${webOrigin()}/integrations/${integration}`,
      };
    }
    case "retry":
      return {
        source: entry.slug,
        label,
        reason,
        action: `Retry the ${label} connection`,
        actionUrl: `${webOrigin()}/integrations`,
      };
    case "none":
      return {
        source: entry.slug,
        label,
        reason,
        action: "Wait for the subscription to recover, or ask an operator to check it",
      };
    default: {
      const _exhaustive: never = entry.recovery;
      return _exhaustive;
    }
  }
}

/** The degraded-source block in both bodies the briefing carries. */
export interface DegradedSourceBlock {
  markdown: string;
  text: string;
}

/**
 * Render one line per degraded source: the source, the reason its own check
 * gave, and the one action that repairs it. The caller appends the block after
 * the agent's prose, so the paragraph the agent wrote is untouched and the user
 * acts on the line without a triage step.
 *
 * No dashes, matching the briefing voice.
 */
export function formatDegradedSources(
  items: readonly BriefingDegradedSource[],
): DegradedSourceBlock {
  return {
    markdown: items
      .map(
        (item) =>
          `**${item.label} deliveries are paused:** ${item.reason}. ` +
          (item.actionUrl ? `[${item.action}](${item.actionUrl}).` : `${item.action}.`),
      )
      .join("\n\n"),
    text: items
      .map(
        (item) =>
          `${item.label} deliveries are paused: ${item.reason}. ` +
          (item.actionUrl ? `${item.action}: ${item.actionUrl}` : `${item.action}.`),
      )
      .join("\n\n"),
  };
}

function withoutTrailingPeriod(value: string): string {
  return value.trim().replace(/\.+$/, "");
}
