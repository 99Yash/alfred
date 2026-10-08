import { isNonEmptyString, toStringArray as coerceStringArray } from "@alfred/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { ApprovalsRoute } from "./-approvals/approvals-route";

/**
 * Live `/approvals`. `AppShell` redirects signed-out users, so this route only
 * handles the session-pending window, which renders outside the themed chrome.
 */
/** A single value or repeated key, as a string[]. */
function toStringArray(value: unknown): string[] | undefined {
  const arr = coerceStringArray(value);

  if (arr.length > 0) return arr;

  return isNonEmptyString(value) ? [value] : undefined;
}

export interface ApprovalsSearch {
  /** Absent means no filter. */
  integration?: string[] | undefined;
  /** Absent means no filter. */
  risk?: string[] | undefined;
}

export const Route = createFileRoute("/approvals")({
  head: () => pageMeta({ title: "Approvals", path: "/approvals" }),
  component: ApprovalsRoute,
  validateSearch: (search): ApprovalsSearch => ({
    integration: toStringArray(search.integration),
    risk: toStringArray(search.risk),
  }),
});
