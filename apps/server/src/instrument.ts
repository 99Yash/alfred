import { serverEnv } from "@alfred/env/server";
import * as Sentry from "@sentry/node";

const { SENTRY_DSN, NODE_ENV, SENTRY_ENABLE_DEV } = serverEnv();

// Only capture in production by default. A DSN in a local `.env` would
// otherwise ship every mid-edit crash to Sentry as `environment: development`
// and bury the real prod signals. `SENTRY_ENABLE_DEV=true` opts a dev box in.
if (SENTRY_DSN && (NODE_ENV === "production" || SENTRY_ENABLE_DEV)) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: NODE_ENV,
    tracesSampleRate: NODE_ENV === "production" ? 0.1 : 1.0,
    sendDefaultPii: false,
  });
}
