import { route, meteredGenerateText, isStepCount, type ModelMessage } from "@alfred/ai";
import {
  assertNever,
  type BriefingClosedLoop,
  type BriefingGather,
  type BriefingLoopRelevance,
  type DayShape,
  type GatherInput,
  type GatherProvenance,
  type IanaTimezone,
} from "@alfred/contracts";
import {
  BROKEN_CONNECTION_GUIDANCE,
  describeBrokenConnection,
  type ActivityWindow,
  type BrokenConnection,
} from "@alfred/assistant/connections";
import { inZone, type LocalDateKey } from "@alfred/assistant/time";
import { selfIdentityGrounding } from "@alfred/assistant/settings";
import { buildSystemPrompt } from "./prompt";
import {
  buildBriefingTools,
  officialWarningsRead,
  type BriefingToolName,
  type DumpedBriefing,
} from "./tools";
import { provenanceAudience, officialWarningsFallback } from "../provenance";
import { describeWarning } from "../official-warnings";
import { describeOpenAskViolation, type OpenAskViolation } from "../open-ask-guard";

/** Daily-briefing agent. Uses the AI SDK tool loop (`generateText` + `stopWhen`) in one workflow step. */

export interface RunBriefingAgentArgs {
  userId: string;
  slot: "morning" | "evening";
  recipientFirstName: string | null;
  /** Exclusive lower bound on `documents.ingested_at`; null on the first run. */
  sinceIngestedAt: Date | null;
  /** Frozen at run start. */
  untilIngestedAt: Date;
  /** The gather's activity window. `list_activity` and `get_day_shape` read it. */
  activityWindow: ActivityWindow;
  /** Anchors the calendar tool's window. */
  briefingDate: LocalDateKey;
  /** Local day boundaries for the calendar tool. */
  timezone: IanaTimezone;
  /** For metering attribution. */
  runId: string;
  stepId: string;
  /** Closure facts from this run's gather. */
  closedLoops: BriefingClosedLoop[];
  /** One verdict per live loop, from the same gather. */
  loopRelevance: BriefingLoopRelevance[];
  /** The gather's day shape, so `get_day_shape` does not repeat the live GitHub read. */
  dayShape?: DayShape | undefined;
  /**
   * The gather's calendar read, so `list_calendar_events` and the calendar statement come from one
   * read. `null`: the gather could not read it. Absent on a run from before this field.
   */
  calendar?: BriefingGather["calendar"] | undefined;
  /**
   * The gather's official warnings. Each warning is a seed fact (`officialWarningFacts`), and
   * `list_official_warnings` gives the full details. `null`: the gather read no feed. Absent on a
   * run from before this field.
   */
  officialWarnings?: BriefingGather["official_warnings"];
  /**
   * Connections the user must repair. The composer writes one notice per connection; the email
   * renders each notice with its repair link below the body.
   */
  brokenConnections: readonly BrokenConnection[];
  /**
   * How the gather read each input (ADR-0117 decision 1). The composer gets a fact for each entry
   * that `provenanceAudience` gives to the composer, when `COMPOSER_READS` lists the entry's input.
   * Absent on a run from before provenance.
   */
  provenance?: readonly GatherProvenance[] | undefined;
  /** Only on a re-prompt: earlier violations, named back verbatim so the rewrite is aimed (#1082). */
  openAskViolations?: readonly OpenAskViolation[];
  /** Only on a re-prompt: connection keys the earlier draft wrote no notice for. */
  missingConnectionNotices?: readonly string[];
}

export interface RunBriefingAgentResult {
  briefing: DumpedBriefing;
  usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
  modelId: string;
  steps: number;
}

const MAX_STEPS = 8;

/**
 * Up to eight boss steps at medium reasoning. The value is the 600 s backstop of the metered
 * wrappers, so the deadline does not change. The workflow step has no signal to combine.
 */
const AGENT_TIMEOUT_MS = 600_000;

/**
 * The broken connections as facts (ADR-0100 amendment 2026-10-28, revised). The code supplies
 * what it knows; the composer decides what to tell the user, one notice per connection. The send
 * step adds the repair link and checks that every key has a notice.
 */
function brokenConnectionFacts(connections: readonly BrokenConnection[]): string {
  if (connections.length === 0) return "";

  return (
    `\n\nThese connections need the user to repair them. ` +
    `Write one entry in connectionNotices for each key below, in the briefing's voice.\n\n` +
    `${BROKEN_CONNECTION_GUIDANCE}\n` +
    `The notices render below your body, so do not repeat them in the body. ` +
    `The body must not say that nothing needs attention, or that you saw everything from these sources.\n\n` +
    connections.map(describeBrokenConnection).join("\n")
  );
}

/** One input that the composer reads, and what the user cannot see when Alfred could not read it. */
interface ComposerRead {
  /** The tool that returns the input. Typed against the bag, so a renamed tool fails `check-types`. */
  readonly tool: BriefingToolName;
  /** What a blind read hides from this briefing, as a noun phrase. */
  readonly hides: string;
}

/**
 * The inputs that the composer reads through its tools, and so the inputs that get a composer
 * fact. Warnings reach it as seed facts (`officialWarningFacts`) and through
 * `list_official_warnings`, so a warnings `fallback` (the default city) is a fact, while the same
 * weather `fallback` is a log line only: weather does not reach the composer. The activity record
 * reaches it through `list_activity` (ADR-0118 slice 3), so a gap in the record is a fact. The
 * verified pull is a separate input, `deploy_status`: `list_activity` never returns its items, and
 * `get_day_shape` counts them in `activityVolume`. So a failed pull names `get_day_shape`, whose
 * volume can then be too low. A stale item left the list in the gather, and no tool returns it,
 * so a `stale` entry stays a log line (`provenanceAudience`).
 */
const COMPOSER_READS = {
  email: { tool: "list_emails_since", hides: "your new email" },
  calendar: { tool: "list_calendar_events", hides: "your meetings" },
  github_merged: { tool: "get_day_shape", hides: "the work that merged on GitHub" },
  loop_relevance: {
    tool: "list_loop_relevance",
    hides: "whether your open threads still need you",
  },
  official_warnings: {
    tool: "list_official_warnings",
    hides: "official hazard warnings for your area",
  },
  integration_activity: {
    tool: "list_activity",
    hides: "what happened in your connected tools",
  },
  deploy_status: {
    tool: "get_day_shape",
    hides: "the status of your deploys, and how active the day was",
  },
  weather: null,
} as const satisfies Record<GatherInput, ComposerRead | null>;

type UnavailableCause = Extract<GatherProvenance, { state: "unavailable" }>["cause"];

/**
 * What a blind input costs this briefing, for each cause. A cause the user can repair names the
 * repair, because the read stays blind until the user does it. `no_place` reaches the composer
 * only for warnings, in three cases: Alfred has no place, so it read no feed; Alfred does not know
 * the country of the place; or the place is in India and has no NDMA Sachet district. In the last
 * two cases, Alfred read only GDACS. So it says "may be missing", which is true in each case.
 */
const BLIND_COST = {
  not_connected: "So this briefing cannot see",
  needs_reauth: "Until the user signs in again, this briefing cannot see",
  scope_missing: "Until the user grants that permission, this briefing cannot see",
  not_delivered: "Until the user reconnects, this briefing cannot see",
  read_failed: "So this briefing may be missing",
  no_place: "So this briefing may be missing",
  silent: "So this briefing may be missing",
  record_incomplete: "So this briefing may be missing",
  window_clipped: "So this briefing does not show the older part of",
} as const satisfies Record<Exclude<UnavailableCause, "no_record">, string>;

/**
 * One composer fact: the tool, what Alfred knows about the read, and what it costs. Of the inputs
 * in `COMPOSER_READS`, only warnings states `fallback`.
 */
function composerFact(entry: GatherProvenance, read: ComposerRead): string | null {
  switch (entry.state) {
    // A live read is not a fact for the composer (`provenanceAudience`).
    case "live":
      return null;
    case "fallback":
      return `- ${read.tool}: ${entry.reason} Alfred used a default: ${entry.used}. So this briefing may be missing ${read.hides}.`;
    // `provenanceAudience` keeps a stale entry out: the tool never returns the old item.
    case "stale":
      return null;
    case "unavailable":
      // `provenanceAudience` keeps `no_record` out: it is the scope of the record, which the
      // `list_activity` description states, not a failure of this read.
      if (entry.cause === "no_record") return null;

      return `- ${read.tool}: ${entry.reason} ${BLIND_COST[entry.cause]} ${read.hides}.`;
    default:
      return assertNever(entry, "provenance state");
  }
}

/**
 * The composer's facts about how the gather read its inputs (ADR-0117 decision 2).
 * `provenanceAudience` decides which entries the composer gets, and `COMPOSER_READS` keeps the
 * inputs that the composer reads. A `not_connected` input gets a fact and no block row, so the
 * body is the only place that says it. An empty result from such an input is not evidence, so
 * the composer must not turn it into "nothing needs attention".
 */
function inputProvenanceFacts(provenance: readonly GatherProvenance[]): string {
  const lines = provenance.flatMap((entry) => {
    const read = COMPOSER_READS[entry.input];

    if (read === null || !provenanceAudience(entry).composerFact) return [];

    const fact = composerFact(entry, read);

    return fact === null ? [] : [fact];
  });

  if (lines.length === 0) return "";

  return (
    `\n\nAlfred did not get a full, current read of these inputs for this briefing. ` +
    `Each line names the tool, what Alfred knows, and what this briefing cannot see as a result. ` +
    `What those tools return is incomplete. ` +
    `Acknowledge each one in the body in one short clause: name the source, say what you could not read or which default you used, and say what the user cannot rely on as a result. ` +
    `Put the clause where it matters, for example where you talk about the day ahead for the calendar. ` +
    `For example: Calendar isn't connected, so I can't see your meetings. ` +
    `When a connection key above names the same source, its notice already says this below the body, so do not repeat it. ` +
    `Never say or imply that nothing needs attention, that the day is clear, that the day was quiet, or that you saw everything, on the basis of these inputs. ` +
    `Write a connection notice only for a key listed above.\n\n` +
    lines.join("\n")
  );
}

/**
 * Each selected official warning as a seed fact, so a warning leads the briefing whether or not
 * the composer calls `list_official_warnings` (ADR-0117 decision 4: a selected warning ranks
 * first). The tool gives the headline and the link. A run with no warning, or with no read, gets no
 * line here: its provenance fact says what Alfred could not read, and a missing read is not a
 * clear one.
 *
 * The place is the user's place, or the default city of the zone when the warnings `fallback`
 * names it. The feed text is clipped and parsed at the gather (`buildWarning`).
 */
function officialWarningFacts(args: {
  officialWarnings: BriefingGather["official_warnings"];
  provenance: readonly GatherProvenance[];
  timezone: IanaTimezone;
}): string {
  const read = officialWarningsRead(args.officialWarnings);

  if (read.status !== "read" || read.items.length === 0) return "";

  const fallback = officialWarningsFallback(args.provenance);

  const place =
    fallback === undefined
      ? "the user's place"
      : `${fallback.used}, the default city for the user's time zone. It is not a place that the user gave, so name ${fallback.used} with the warning`;

  const zone = inZone(args.timezone);

  return (
    `\n\nThese official hazard warnings cover ${place}. ` +
    `A geometry or district match selected each one, not a model. ` +
    `They are something wrong or at risk, and they rank first: lead the body with them, most severe first, in this order. ` +
    `For each one, name the issuer and what it warns of, and keep its severity word. ` +
    `Do not add advice that the warning does not give, and do not soften or inflate its severity. ` +
    `Call list_official_warnings only if you need a headline or a link.\n\n` +
    read.items
      .map((warning) => `- ${describeWarning(warning, zone)}, in the user's time zone.`)
      .join("\n")
  );
}

/** Re-prompt text for keys the earlier draft wrote no notice for. */
function connectionNoticeCorrection(missing: readonly string[]): string {
  if (missing.length === 0) return "";

  return (
    `\n\nYour previous draft wrote no connectionNotices entry for these keys: ${missing.join(", ")}. ` +
    `Write one for each key this time.`
  );
}

export async function runBriefingAgent(
  args: RunBriefingAgentArgs,
): Promise<RunBriefingAgentResult> {
  const system = buildSystemPrompt({
    slot: args.slot,
    recipientFirstName: args.recipientFirstName,
    selfIdentity: selfIdentityGrounding(),
  });

  const bag = buildBriefingTools({
    userId: args.userId,
    slot: args.slot,
    sinceIngestedAt: args.sinceIngestedAt,
    untilIngestedAt: args.untilIngestedAt,
    activityWindow: args.activityWindow,
    briefingDate: args.briefingDate,
    timezone: args.timezone,
    closedLoops: args.closedLoops,
    loopRelevance: args.loopRelevance,
    dayShape: args.dayShape,
    calendar: args.calendar,
    officialWarnings: args.officialWarnings,
  });

  const seed: ModelMessage[] = [
    {
      role: "user",
      content:
        `Compose the ${args.slot} briefing for ${args.recipientFirstName ?? "the user"}. ` +
        `Start by reading list_prior_briefings, then list_emails_since, list_closed_loops, and list_loop_relevance. ` +
        `Apply the three honest loop-state tiers, then end with dump_briefing.` +
        officialWarningFacts({
          officialWarnings: args.officialWarnings,
          provenance: args.provenance ?? [],
          timezone: args.timezone,
        }) +
        brokenConnectionFacts(args.brokenConnections) +
        // No list is a gather from before this build. It states nothing, so it adds no fact.
        inputProvenanceFacts(args.provenance ?? []) +
        openAskCorrection(args.openAskViolations ?? []) +
        connectionNoticeCorrection(args.missingConnectionNotices ?? []),
    },
  ];

  const result = await meteredGenerateText(
    {
      model: route("boss").model(),
      instructions: system,
      messages: seed,
      tools: bag.tools,
      // If `dump_briefing` is not reached in this budget, fail rather than burn tokens.
      stopWhen: isStepCount(MAX_STEPS),
      abortSignal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    },
    {
      // `briefing` is the cost bucket (ADR-0041), not the call shape. Langfuse tags
      // (`call_kind:llm`, `cost_kind:briefing`) split both back out.
      kind: "briefing",
      role: "briefing",
      userId: args.userId,
      runId: args.runId,
      stepId: args.stepId,
      name: `agent:daily-briefing:${args.slot}`,
    },
  );

  const briefing = bag.getDumped();

  if (!briefing) {
    throw new Error(
      `[briefing-agent] loop ended without dump_briefing call. ` +
        `finishReason=${result.finishReason} steps=${result.steps.length}`,
    );
  }

  return {
    briefing,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
    // The leg that wrote the briefing: the step whose `dump_briefing` tool call actually ran.
    // A trailing wrap-up step starts on the primary again, so `finalStep`
    // would name a leg that did not produce the stored prose.
    modelId: modelIdOfDumpStep(result.steps),
    steps: result.steps.length,
  };
}

/**
 * The serving leg of the step whose `dump_briefing` tool call actually ran. A
 * `tool-result` part exists only when `execute` returned, and a successful
 * `execute` is the only writer of the stored briefing, so the last step with
 * that result is the step that wrote it. `toolCalls` would also match a
 * rejected or throwing call that wrote nothing. The caller already threw when
 * no dump happened, so this is always found.
 */
function modelIdOfDumpStep(
  steps: readonly {
    toolResults: readonly { toolName: string }[];
    response: { modelId: string };
  }[],
): string {
  const step = steps.findLast((s) => s.toolResults.some((r) => r.toolName === "dump_briefing"));

  if (!step) {
    throw new Error(
      `[briefing-agent] loop ended without dump_briefing call. steps=${steps.length}`,
    );
  }

  return step.response.modelId;
}

/** The re-prompt text built from the guard's findings. One extra compose before the guard drops sentences. */
function openAskCorrection(violations: readonly OpenAskViolation[]): string {
  if (violations.length === 0) return "";

  const lines = violations
    .map((violation) => `- ${describeOpenAskViolation(violation)}`)
    .join("\n");

  return (
    `\n\nYour previous draft was rejected. The object-state projection proves each object below is closed, ` +
    `and your draft still framed it as work the user owes:\n${lines}\n` +
    `Rewrite the briefing. Keep each closed object only in the past-tense closed-today recap that the loop-state tiers require. ` +
    `Never ask the user to review, approve, merge, or follow up on it.`
  );
}
