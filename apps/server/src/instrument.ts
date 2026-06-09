import { serverEnv } from "@alfred/env/server";
import * as Sentry from "@sentry/node";

const { SENTRY_DSN, NODE_ENV } = serverEnv();

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: NODE_ENV,
    tracesSampleRate: NODE_ENV === "production" ? 0.1 : 1.0,
    sendDefaultPii: false,
  });
}
