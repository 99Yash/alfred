import * as Sentry from "@sentry/node";
import type { SeverityLevel } from "@sentry/node";
import { logger } from "./logger";

/** Derived from the SDK, so a rename there fails tsc. */
export type ReportedLevel = Extract<SeverityLevel, "warning" | "error">;

/**
 * A handled condition an operator should see. Sentry only catches thrown errors,
 * so a silent drop otherwise lives only in a log line nobody reads.
 * Sentry counts events per fingerprint; it is not a metric.
 */
export interface ReportedSignal {
  /** Stable dotted name, e.g. `ingress.no_owner`. No ids: it leads the fingerprint. */
  event: string;
  /** One sentence about what happened. Constant per `event`; varying facts go in `tags`. */
  message: string;
  /** `warning` if expected sometimes; `error` if it always means a fault. */
  level: ReportedLevel;
  /** Facts that vary. Never a body, credential, or secret: truncation does not make a value safe. */
  tags: Readonly<Record<string, string>>;
  /** Fingerprint is `[event, ...dimensions]`. No per-occurrence ids, or each event is its own issue. */
  dimensions: readonly string[];
}

/** Bounds what a hostile provider field can push into either sink. */
const TAG_VALUE_CAP = 200;

/** Keys pino writes itself. A tag with one would overwrite pino's value, so the log line drops it. */
const PINO_OWNED_KEYS: ReadonlySet<string> = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "name",
  "msg",
]);

/** Report a handled condition to the log and to Sentry. Never throws. */
export function report(signal: ReportedSignal): void {
  const tags = boundedTags(signal.tags);
  // `event` goes last so a caller tag cannot replace it.
  const line = pinoLine(tags, signal.event);

  // Pino says `warn`, Sentry says `warning`.
  try {
    if (signal.level === "error") logger.error(line, signal.message);
    else logger.warn(line, signal.message);
  } catch {
    // Still send to Sentry.
  }

  try {
    Sentry.captureMessage(signal.message, {
      level: signal.level,
      tags: { ...tags, event: signal.event },
      fingerprint: [signal.event, ...signal.dimensions],
    });
  } catch {
    // The log line already landed. Do not fail the caller.
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
