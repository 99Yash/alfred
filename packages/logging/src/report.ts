import * as Sentry from "@sentry/node";
import type { SeverityLevel } from "@sentry/node";
import { logger } from "./logger";

/**
 * The levels a handled condition may report at, in Sentry's spelling. Derived
 * from the SDK, so a rename on its side fails tsc instead of quietly dropping
 * the event into an unleveled default.
 */
export type ReportedLevel = Extract<SeverityLevel, "warning" | "error">;

/**
 * The door for an operator signal that is not an exception.
 *
 * Sentry's Node SDK captures an uncaught error, and nothing else. A condition
 * the process handles correctly — it answers, it stays up, it drops one input
 * on purpose — throws nothing, so it reaches no sink but the log. A log line
 * is readable only by someone who already suspects the fault and knows which
 * process to open, and #1033 proves what that costs: an inbound source dropped
 * every delivery for weeks behind one `console.warn`, and the report came from
 * an external monitor twice before Alfred said anything.
 *
 * `report` is the second half of such a condition: the branch keeps its
 * behavior, and says so somewhere a person finds later. It writes BOTH sinks,
 * because they answer different questions. The log line carries the ordering
 * and the neighbors, and it is the only sink on a dev box, where `Sentry.init`
 * never runs (`apps/server/src/instrument.ts` needs a DSN and production).
 * The Sentry event carries the count.
 *
 * It is not a metric. Sentry groups events by fingerprint and counts each
 * group, which is what makes one drop distinguishable from a hundred; it does
 * not aggregate a value, and a caller that needs a rate needs a durable row
 * instead.
 */
export interface ReportedSignal {
  /**
   * The stable dotted name of the condition (`ingress.no_owner`). It leads the
   * fingerprint, so it must not carry an id: a name that varies per occurrence
   * is a group of one, and a group of one cannot be counted. The Sentry title
   * comes from {@link ReportedSignal.message}, not from this name.
   */
  event: string;
  /**
   * One sentence describing what the process did, written for whoever opens
   * the issue months later. Keep it constant per `event`; the facts that vary
   * belong in {@link ReportedSignal.tags}.
   */
  message: string;
  /** `warning` for a condition the design admits and expects to see sometimes; `error` for one that always means a fault. */
  level: ReportedLevel;
  /**
   * The facts that vary, as scalars. Sentry indexes them, so a reader filters
   * and compares on them without opening anything.
   *
   * Never a request body, never a credential, never a secret. Values are
   * truncated to {@link TAG_VALUE_CAP}, which bounds what a hostile provider
   * field can push into a sink but does not make an unsafe value safe: only
   * the call site knows which fields those are.
   */
  tags: Readonly<Record<string, string>>;
  /**
   * The values that separate one instance of this condition from another, in
   * order. The fingerprint is `[event, ...dimensions]`, so the event name is
   * never repeated here and the two cannot disagree. Keep per-occurrence ids
   * out: a dimension that changes per delivery makes every event its own
   * issue.
   */
  dimensions: readonly string[];
}

/**
 * A tag value is cut here so a hostile provider field cannot push unbounded
 * text into either sink. Neither sink promises this exact limit; the cut is a
 * local bound, applied before the value reaches either.
 */
const TAG_VALUE_CAP = 200;

/**
 * The field names pino writes into the line itself. A tag with one of these
 * keys would emit a duplicate JSON key, and the later one wins on parse, so
 * pino's own `level`, `time`, or `pid` would be lost. Those tags stay on the
 * Sentry event; only the log line drops them.
 */
const PINO_OWNED_KEYS: ReadonlySet<string> = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "name",
  "msg",
]);

/**
 * Report one handled condition to the log and to Sentry.
 *
 * Never throws and never rejects: a reporting sink that can fail the branch it
 * observes is worse than the silence it replaces. `captureMessage` is a no-op
 * when the SDK holds no client, which is the ordinary state outside production.
 */
export function report(signal: ReportedSignal): void {
  const tags = boundedTags(signal.tags);
  // Caller tags first: a tag keyed `event` must not replace the stable name
  // that leads the fingerprint, and one keyed a pino field must not shadow the
  // field pino owns. Each sink is independent, so a failure in one cannot
  // suppress the other or reach the caller.
  const line = pinoLine(tags, signal.event);

  // Pino spells the level `warn` and Sentry spells it `warning`; the mapping
  // stays here rather than in every caller.
  try {
    if (signal.level === "error") logger.error(line, signal.message);
    else logger.warn(line, signal.message);
  } catch {
    // The Sentry event below is the other half of the report.
  }

  try {
    Sentry.captureMessage(signal.message, {
      level: signal.level,
      tags: { ...tags, event: signal.event },
      fingerprint: [signal.event, ...signal.dimensions],
    });
  } catch {
    // The log line above already landed. Losing the Sentry copy is not worth
    // failing a caller that was in the middle of handling something else.
  }
}

function pinoLine(tags: Readonly<Record<string, string>>, event: string) {
  const line: Record<string, string> = {};

  for (const [key, value] of Object.entries(tags)) {
    if (!PINO_OWNED_KEYS.has(key)) line[key] = value;
  }

  line.event = event;

  return line;
}

function boundedTags(tags: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [key, value.slice(0, TAG_VALUE_CAP)]),
  );
}
