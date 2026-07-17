import * as Sentry from "@sentry/react";
import posthog from "posthog-js";

export function initObservability() {
  // Only capture in production by default. A DSN in local dev would otherwise
  // ship Vite HMR churn and mid-edit crashes to Sentry as `environment:
  // development`. Set `VITE_SENTRY_ENABLE_DEV=true` to opt a dev box in.
  const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
  const sentryEnabled = import.meta.env.PROD || import.meta.env.VITE_SENTRY_ENABLE_DEV === "true";
  if (sentryDsn && sentryEnabled) {
    Sentry.init({
      dsn: sentryDsn,
      environment: import.meta.env.MODE,
      tracesSampleRate: import.meta.env.MODE === "production" ? 0.1 : 1.0,
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
      ],
    });
  }

  const posthogKey = import.meta.env.VITE_POSTHOG_KEY;
  if (posthogKey) {
    posthog.init(posthogKey, {
      api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: "history_change",
    });
  }
}
