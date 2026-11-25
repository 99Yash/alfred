import { isNonEmptyString } from "@alfred/contracts";
import * as Sentry from "@sentry/react";
import posthog, { type CaptureResult, type Properties } from "posthog-js";
import type { FileRoutesByFullPath } from "~/routeTree.gen";

/**
 * The route pattern of a web path, for example `/chat/$threadId`. `undefined` when no route
 * matches. `main.tsx` passes the router's own matcher, so a new route needs no edit here.
 */
export type RoutePatternOf = (pathname: string) => string | undefined;

/**
 * The public share page (ADR-0102). Its slug is the full read capability of a thread, and its
 * viewers are not the owner, so no analytics event leaves this page (#1878).
 */
const SHARE_ROUTE = "/c/$slug" satisfies keyof FileRoutesByFullPath;

/** Property keys whose value is a URL or a path. PostHog sends these on every event. */
const URL_PROPERTY = /(url|pathname|referrer)$/i;

/** Page titles can quote a thread title or mail text (`chat-thread-route.tsx`). */
const TITLE_PROPERTIES = ["$title", "title"] as const;

export function initObservability(routePatternOf: RoutePatternOf) {
  /**
   * A URL with no query and no fragment. A web path becomes its route pattern, so a share slug,
   * a thread id, or a `?google_connected=<email>` never reaches a vendor (#1878).
   */
  const scrubUrl = (raw: string): string => {
    let url: URL;

    try {
      url = new URL(raw, window.location.origin);
    } catch {
      return "[unparseable-url]";
    }

    if (url.origin !== window.location.origin) return `${url.origin}${url.pathname}`;

    return `${url.origin}${routePatternOf(url.pathname) ?? "/[unknown-route]"}`;
  };

  const isSharePath = (raw: string): boolean => {
    try {
      return routePatternOf(new URL(raw, window.location.origin).pathname) === SHARE_ROUTE;
    } catch {
      return false;
    }
  };

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
      // The same URL scrub as PostHog: Sentry sees the page URL, navigation
      // breadcrumbs, and the transaction name, which is the path.
      beforeSend: (event) => {
        if (event.request?.url) event.request.url = scrubUrl(event.request.url);

        if (event.request) delete event.request.query_string;

        return event;
      },
      beforeSendTransaction: (event) => {
        if (event.transaction?.startsWith("/")) event.transaction = scrubUrl(event.transaction);

        if (event.request?.url) event.request.url = scrubUrl(event.request.url);

        if (event.request) delete event.request.query_string;

        return event;
      },
      beforeBreadcrumb: (breadcrumb) => {
        const data = breadcrumb.data;

        if (!data) return breadcrumb;

        for (const key of ["from", "to", "url"] as const) {
          const value: unknown = data[key];

          if (isNonEmptyString(value)) data[key] = scrubUrl(value);
        }

        return breadcrumb;
      },
    });
  }

  const posthogKey = import.meta.env.VITE_POSTHOG_KEY;

  // An outside viewer who opens a share link never loads PostHog: no cookie, no request.
  if (posthogKey && !isSharePath(window.location.href)) {
    const scrubProperties = (properties: Properties | undefined): void => {
      if (!properties) return;

      for (const key of TITLE_PROPERTIES) delete properties[key];

      for (const [key, value] of Object.entries(properties)) {
        if (URL_PROPERTY.test(key) && isNonEmptyString(value)) properties[key] = scrubUrl(value);
      }
    };

    const beforeSend = (event: CaptureResult | null): CaptureResult | null => {
      if (!event) return null;
      const currentUrl: unknown = event.properties.$current_url;

      // The owner can navigate to a share page inside the app; drop that event.
      if (isNonEmptyString(currentUrl) && isSharePath(currentUrl)) return null;

      scrubProperties(event.properties);
      scrubProperties(event.$set);
      scrubProperties(event.$set_once);

      return event;
    };

    posthog.init(posthogKey, {
      api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: "history_change",
      // A PostHog project setting cannot turn session recording on.
      disable_session_recording: true,
      // A click event carries the text of the element: mail subjects and sender
      // names. Page views and the scrub below are the whole capture (#1878).
      autocapture: false,
      rageclick: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      before_send: beforeSend,
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
