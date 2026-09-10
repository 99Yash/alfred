import * as Sentry from "@sentry/node";
import { logger } from "./logger";

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
   * fingerprint and the Sentry title, so it must not carry an id: a name that
   * varies per occurrence is a group of one, and a group of one cannot be
   * counted.
   */
  event: string;
  /**
   * One sentence describing what the process did, written for whoever opens
   * the issue months later. Keep it constant per `event`; the facts that vary
   * belong in `tags`.
   */
  message: string;
  /**
   * `warning` for a condition the design admits and expects to see sometimes;
   * `error` for one that always means a fault. The level is what decides
   * whether an alert rule can fire on the issue, so it is the caller's choice
   * rather than a default.
   */
  level: "warning" | "error";
  /**
   * The facts that vary, as scalars. Sentry indexes them, so a reader filters
   * and compares on them without opening anything.
   *
   * Never a request body, never a credential, never a secret. Values are
   * truncated to {@link TAG_VALUE_CAP}, which bounds what a hostile provider
   * field can push into the sink but does not make an unsafe value safe: only
   * the call site knows which fields those are.
   */
  tags: Readonly<Record<string, string>>;
  /**
   * What makes two reports one issue, and therefore what the count counts.
   * Name only the dimensions worth separating; a fact left out of the
   * fingerprint is still readable on the event and still filterable as a tag.
   */
  fingerprint: readonly string[];
}

/** Sentry drops a tag value past 200 characters, so the cut happens here, where it is visible. */
const TAG_VALUE_CAP = 200;

/**
 * Report one handled condition to the log and to Sentry.
 *
 * Never throws and never rejects: a reporting sink that can fail the branch it
 * observes is worse than the silence it replaces. `captureMessage` is a no-op
 * when the SDK holds no client, which is the ordinary state outside production.
 */
export function report(signal: ReportedSignal): void {
  const tags = boundedTags(signal.tags);
  // Pino spells the level `warn` and Sentry spells it `warning`. The interface
  // takes Sentry's spelling, because the Sentry event is the half that carries
  // the count, and the mapping stays here rather than at every call site.
  const line = { event: signal.event, ...tags };
  if (signal.level === "error") logger.error(line, signal.message);
  else logger.warn(line, signal.message);
  try {
    Sentry.captureMessage(signal.message, {
      level: signal.level,
      tags: { event: signal.event, ...tags },
      fingerprint: [...signal.fingerprint],
    });
  } catch {
    // The log line above already landed. Losing the Sentry copy is not worth
    // failing a caller that was in the middle of handling something else.
  }
}

function boundedTags(tags: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [key, value.slice(0, TAG_VALUE_CAP)]),
  );
}
