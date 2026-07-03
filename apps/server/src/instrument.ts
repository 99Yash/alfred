import { serverEnv } from "@alfred/env/server";
import * as Sentry from "@sentry/node";

const { SENTRY_DSN, NODE_ENV, SENTRY_ENABLE_DEV, SENTRY_RELEASE } = serverEnv();

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
    tracesSampleRate: NODE_ENV === "production" ? 0.1 : 1.0,
    sendDefaultPii: false,
  });
}
