import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { ApprovalsRoute } from "./-approvals/approvals-route";

/**
 * Live `/approvals` surface. Subscribes to pending `action_stagings` via
 * Replicache and posts approve / reject / cancel decisions through the Eden
 * decision API (`POST /api/approvals/:stagingId/decision`).
 *
 * Auth is gated centrally: `AppShell`'s guard redirects signed-out visitors to
 * `/login` before this route renders, so we only handle the session-pending
 * window here (the loader below) and then assume an authed user. The pending
 * state renders outside the themed app chrome (see `AppShell`'s `showChrome`),
 * so it uses plain grammar like `routes/debug.events.tsx` rather than `app-*`.
 */
/** Normalize a search value to a string[] (single value or repeated key). */
function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const arr = value.filter((v): v is string => typeof v === "string");
    return arr.length > 0 ? arr : undefined;
  }
  return typeof value === "string" && value.length > 0 ? [value] : undefined;
}

export interface ApprovalsSearch {
  /** Selected integration facet values; absent = no integration filter. */
  integration?: string[];
  /** Selected risk-tier facet values; absent = no risk filter. */
  risk?: string[];
}

export const Route = createFileRoute("/approvals")({
  head: () => pageMeta({ title: "Approvals", path: "/approvals" }),
  component: ApprovalsRoute,
  validateSearch: (search): ApprovalsSearch => ({
    integration: toStringArray(search.integration),
    risk: toStringArray(search.risk),
  }),
});
