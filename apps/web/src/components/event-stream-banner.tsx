import { useEventStreamStatus } from "~/lib/events/event-stream-status";

/**
 * Floating notice shown when the shared SSE bus has died with a fatal error
 * (e.g. 401 — session expired — which per WHATWG moves EventSource to CLOSED
 * with no auto-reconnect) and is now backing off before a manual re-open.
 * Transient drops stay in CONNECTING and auto-retry, so they do not show this.
 * Lives alongside the other shell nags (scope-gap, github reconnect) in the
 * absolutely-positioned layer under the header.
 */
export function EventStreamBanner() {
  const status = useEventStreamStatus();
  if (status !== "reconnecting") return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto flex w-full max-w-2xl items-center justify-center gap-2 rounded-xl border border-app-fg-a1 bg-app-bg-1/90 px-3.5 py-2.5 text-[13px] leading-snug text-app-fg-4 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)] backdrop-blur-sm"
    >
      <span
        className="inline-flex size-2 shrink-0 animate-pulse rounded-full bg-amber-500"
        aria-hidden
      />
      <span>Live updates disconnected — reconnecting…</span>
    </div>
  );
}
