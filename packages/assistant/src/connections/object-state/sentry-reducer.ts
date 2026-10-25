import { linkNamesObject, type SentryIssueNativeState } from "@alfred/contracts";
import type { ObjectStateEvent, SentryLifecycleEventType } from "./events";
import type { ObjectStateDelta } from "./store";

/**
 * Sentry reducer (ADR-0062, ADR-0103, #1090). Pure. State comes from the event type, not
 * `data.issue.status`, which can lag the transition that caused the delivery. Absorption and
 * closure are declared in `INTEGRATION_OBJECT_DEFS.sentry.issue`.
 */
export function reduceSentryEvent(
  event: Extract<ObjectStateEvent, { provider: "sentry" }>,
): ObjectStateDelta[] {
  const nativeState = issueNativeState(event.eventType);
  const issue = event.payload.data?.issue;
  // The same id rule as `ingress/sentry.ts`, so the dedup key and the projection agree.
  const issueId = issue?.id;

  if (!issueId) return [];

  const shortId = issue.shortId;
  const projectSlug = issue.project?.slug;
  const permalink = issue.permalink;

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
      title: issue.title,
      // Only a `sentry.io` permalink whose `/issues/<id>` is this issue. Else `url` stays null;
      // identity rides on the id.
      url:
        permalink && linkNamesObject("sentry", "issue", permalink, { issue_id: issueId })
          ? permalink
          : undefined,
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

/** Lifecycle token for a Sentry lifecycle event type. Exhaustive like `sentryDeliveryKey`. */
function issueNativeState(eventType: SentryLifecycleEventType): SentryIssueNativeState {
  switch (eventType) {
    case "issue_created":
    case "issue_unresolved":
      return "unresolved";
    case "issue_resolved":
      return "resolved";
    case "issue_archived":
      return "archived";
    default: {
      const _exhaustive: never = eventType;

      return _exhaustive;
    }
  }
}
