import { redactSensitiveLogPaths } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import * as Sentry from "@sentry/node";

const { SENTRY_DSN, NODE_ENV, SENTRY_ENABLE_DEV, SENTRY_RELEASE, SENTRY_TRACES_SAMPLE_RATE } =
  serverEnv();

// Only capture in production by default. A DSN in a local `.env` would
// otherwise ship every mid-edit crash to Sentry as `environment: development`
// and bury the real prod signals. `SENTRY_ENABLE_DEV=true` opts a dev box in.
if (SENTRY_DSN && (NODE_ENV === "production" || SENTRY_ENABLE_DEV)) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: NODE_ENV,
    // Only override when SENTRY_RELEASE is explicitly set. Left unset, the SDK
    // auto-detects the release from Railway's `RAILWAY_GIT_COMMIT_SHA` (the
    // commit SHA prod issues already carry) — passing `release: undefined`
    // would risk clobbering that. The build-time `sentry-cli` step
    // (scripts/sentry-release.mjs) associates commits/source maps against the
    // same SHA so suspect commits and unminified traces line up.
    ...(SENTRY_RELEASE ? { release: SENTRY_RELEASE } : {}),
    // The one observability lane that is not free, and the reason for the
    // `0` here. Error capture, `beforeSend` and `report()` do not read this
    // number, so switching tracing off costs the latency view and nothing
    // else — see SENTRY_TRACES_SAMPLE_RATE and ADR-0023's amendment.
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE ?? (NODE_ENV === "production" ? 0 : 1),
    sendDefaultPii: false,
    // Strip the shared SENSITIVE_LOG_PATHS set (ADR-0038) from events and
    // breadcrumbs before they leave the process. The same table backs Pino's
    // `redact` config, so no sink can drift from another on what is secret.
    // Stack frames survive; only field values disappear.
    beforeSend(event) {
      return redactSensitiveLogPaths(event);
    },
    beforeBreadcrumb(breadcrumb) {
      return redactSensitiveLogPaths(breadcrumb);
    },
  });
}
