import {
  type EventTypeForSource,
  getIdPath,
  getStringPath,
  isEventTypeForSource,
  type SentryIssueNativeState,
} from "@alfred/contracts";
import { collectSentryIssueIds } from "./sentry-issue-url";
import type { ObjectStateDelta } from "./store";

/**
 * Sentry reducer (ADR-0062, ADR-0103, #1090). Pure. State comes from the event type, not
 * `data.issue.status`, which can lag the transition that caused the delivery. Absorption and
 * closure are declared in `INTEGRATION_OBJECT_DEFS.sentry.issue`.
 */
export function reduceSentryEvent(
  eventType: string,
  _action: string | null,
  payload: unknown,
): ObjectStateDelta[] {
  // Narrow the bare `string` so the switch below is exhaustive (ADR-0097).
  if (!isEventTypeForSource("sentry", eventType)) return [];
  const nativeState = issueNativeState(eventType);

  if (nativeState === null) return [];

  // Same reader as `ingress/sentry.ts`, so the dedup key and the projection agree.
  const issueId = getIdPath(payload, "data", "issue", "id");

  if (!issueId) return [];

  const shortId = getStringPath(payload, "data", "issue", "shortId");
  const projectSlug = getStringPath(payload, "data", "issue", "project", "slug");
  const permalink = getStringPath(payload, "data", "issue", "permalink");

  const keys: ObjectStateDelta["keys"] = [{ keyKind: "issue_id", keyValue: issueId }];

  // Store the key upper-cased, as Sentry renders it, so prose in any case matches. The attribute
  // keeps the verbatim form.
  if (shortId) keys.push({ keyKind: "short_id", keyValue: shortId.toUpperCase() });

  return [
    {
      kind: "issue",
      externalId: issueId,
      nativeState,
      closureSource: "verified_push",
      title: getStringPath(payload, "data", "issue", "title"),
      // Only a permalink that names this issue. Else `url` stays null; identity rides on the id.
      url: permalink && collectSentryIssueIds(permalink).includes(issueId) ? permalink : undefined,
      // A Sentry project is not a repository, so `repo` stays absent.
      attributes: {
        issue_id: issueId,
        ...(shortId ? { short_id: shortId } : {}),
        ...(projectSlug ? { project_slug: projectSlug } : {}),
      },
      keys,
    },
  ];
}

/**
 * Lifecycle token for a Sentry event type, or `null`. Exhaustive like `sentryDeliveryKey`, so a new
 * type does not compile until it is classified here.
 */
function issueNativeState(eventType: EventTypeForSource<"sentry">): SentryIssueNativeState | null {
  switch (eventType) {
    case "issue_created":
    case "issue_unresolved":
      return "unresolved";
    case "issue_resolved":
      return "resolved";
    case "issue_archived":
      return "archived";
    // Not lifecycle transitions. Named, not defaulted, to keep the switch exhaustive.
    case "issue_assigned":
    case "error_created":
    case "event_alert_triggered":
    case "seer_pr_created":
      return null;
    default: {
      const _exhaustive: never = eventType;

      return _exhaustive;
    }
  }
}
