import * as Sentry from "@sentry/react";
import posthog from "posthog-js";

export function initObservability() {
  // Production only, or HMR churn reaches Sentry. `VITE_SENTRY_ENABLE_DEV=true` opts dev in.
  const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
  const sentryEnabled = import.meta.env.PROD || import.meta.env.VITE_SENTRY_ENABLE_DEV === "true";

  if (sentryDsn && sentryEnabled) {
    Sentry.init({
      dsn: sentryDsn,
      environment: import.meta.env.MODE,
      tracesSampleRate: import.meta.env.MODE === "production" ? 0.1 : 1.0,
      // No session replay: one owner, so recordings have little value, and the
      // recorder watches every DOM change (heavy while a reply streams). PostHog
      // recording is off below for the same reason.
      integrations: [Sentry.browserTracingIntegration()],
    });
  }

  const posthogKey = import.meta.env.VITE_POSTHOG_KEY;

  if (posthogKey) {
    posthog.init(posthogKey, {
      api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: "history_change",
      // A PostHog project setting cannot turn session recording on.
      disable_session_recording: true,
    });
  }
}

/**
 * Sends an error to Sentry. A no-op when Sentry is not initialized. Callers import this module
 * instead of `@sentry/react`, so the bundle keeps only the Sentry parts used here.
 */
export function reportError(error: unknown) {
  Sentry.captureException(error);
}
