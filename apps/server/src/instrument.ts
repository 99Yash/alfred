import { redactSensitiveLogPaths } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import * as Sentry from "@sentry/node";

const { SENTRY_DSN, NODE_ENV, SENTRY_ENABLE_DEV, SENTRY_RELEASE, SENTRY_TRACES_SAMPLE_RATE } =
  serverEnv();

// Prod only, so a local DSN does not bury prod issues. `SENTRY_ENABLE_DEV=true` opts in.
if (SENTRY_DSN && (NODE_ENV === "production" || SENTRY_ENABLE_DEV)) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: NODE_ENV,
    // Unset lets the SDK read `RAILWAY_GIT_COMMIT_SHA`. `release: undefined` could clobber it.
    ...(SENTRY_RELEASE ? { release: SENTRY_RELEASE } : {}),
    // Tracing costs money. 0 drops the latency view only, not error capture (ADR-0023).
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE ?? (NODE_ENV === "production" ? 0 : 1),
    sendDefaultPii: false,
    // Same SENSITIVE_LOG_PATHS table as Pino's `redact` (ADR-0038).
    beforeSend(event) {
      return redactSensitiveLogPaths(event);
    },
    beforeBreadcrumb(breadcrumb) {
      return redactSensitiveLogPaths(breadcrumb);
    },
  });
}
