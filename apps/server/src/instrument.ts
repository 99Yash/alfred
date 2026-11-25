import { redactSensitiveLogPaths, sanitizeErrorMessage, summarizeBody } from "@alfred/contracts";
import { deployedCommitSha, serverEnv } from "@alfred/env/server";
import * as Sentry from "@sentry/node";

/**
 * An exception `value` is the raw error message, and a message can quote a provider reply or
 * user text. Redact secret-shaped text and cap the length, as the Langfuse status message does.
 */
function scrubExceptionValues(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const values = event.exception?.values;

  if (values === undefined) return event;

  return {
    ...event,
    exception: {
      ...event.exception,
      values: values.map((exception) =>
        exception.value === undefined
          ? exception
          : { ...exception, value: summarizeBody(sanitizeErrorMessage(exception.value)) },
      ),
    },
  };
}

const { SENTRY_DSN, NODE_ENV, SENTRY_ENABLE_DEV, SENTRY_RELEASE, SENTRY_TRACES_SAMPLE_RATE } =
  serverEnv();

// Release chain: an explicit pin wins, then Railway's git-trigger commit
// (fresh on every git deploy), then the commit the infra program wrote at
// deploy time (ADR-0128; the only source on a context-upload deploy). All
// three unset keeps the SDK default, which reads `RAILWAY_GIT_COMMIT_SHA`.
const release = SENTRY_RELEASE || deployedCommitSha();

// Prod only, so a local DSN does not bury prod issues. `SENTRY_ENABLE_DEV=true` opts in.
if (SENTRY_DSN && (NODE_ENV === "production" || SENTRY_ENABLE_DEV)) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: NODE_ENV,
    // `release: undefined` could clobber the SDK's own default read.
    ...(release ? { release } : {}),
    // Tracing costs money. 0 drops the latency view only, not error capture (ADR-0023).
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE ?? (NODE_ENV === "production" ? 0 : 1),
    // No `dataCollection` on purpose. Unset, SDK 10 keeps its non-PII defaults: no user
    // fields, no HTTP bodies, PII headers filtered. A set `dataCollection` starts from the
    // collect-all defaults instead.
    // Same SENSITIVE_LOG_PATHS table as Pino's `formatters.log` hook (ADR-0038).
    beforeSend(event) {
      return scrubExceptionValues(redactSensitiveLogPaths(event));
    },
    beforeBreadcrumb(breadcrumb) {
      return redactSensitiveLogPaths(breadcrumb);
    },
  });
}
