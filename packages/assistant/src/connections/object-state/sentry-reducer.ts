import {
  type EventTypeForSource,
  getIdPath,
  getStringPath,
  isEventTypeForSource,
} from "@alfred/contracts";
import { collectSentryIssueIds } from "./sentry-issue-url";
import type { ObjectStateDelta } from "./store";

/**
 * Sentry reducer (ADR-0062, ADR-0103, #1090). Pure, idempotent: maps a single
 * verified `issue_*` delivery to the projection delta the store applies. The
 * irreducibly per-provider half, mirroring `reduceGithubEvent` — state is
 * asserted only from a verified webhook body (propose/dispose), so an
 * LLM-proposed key can never fake a resolve.
 *
 * The native-state token comes from the EVENT TYPE, never from
 * `data.issue.status`. The transition is the fact the delivery carries, and
 * the serialized status inside the body can lag the transition that caused the
 * delivery:
 *
 *   issue_created / issue_unresolved → `unresolved` (registry: `active`)
 *   issue_resolved                   → `resolved`   (registry: `resolved`)
 *   issue_archived                   → `archived`   (registry: `abandoned`)
 *
 * `issue_assigned` and every other type is a no-op (`null`): assignment moves
 * no lifecycle state.
 *
 * Nothing about a Sentry issue absorbs, and nothing about it closes an ask —
 * both are declared once in `INTEGRATION_OBJECT_DEFS.sentry.issue`, not here.
 */
export function reduceSentryEvent(
  eventType: string,
  _action: string | null,
  payload: unknown,
): ObjectStateDelta | null {
  // The store's `ReduceFn` hands every provider a bare `string`, because one
  // signature serves every source. Narrow it to this source's own vocabulary
  // here, so the switch below is forced (ADR-0097). A type the registry does
  // not name is a delivery this reducer cannot fold, not an error.
  if (!isEventTypeForSource("sentry", eventType)) return null;
  const nativeState = issueNativeState(eventType);

  if (nativeState === null) return null;

  // The identity. `getIdPath` is what `ingress/sentry.ts` already reads this
  // exact field with, so the dedup key and the projection cannot disagree
  // about where the issue id lives. A body without it is a delivery this
  // reducer cannot fold, not an error.
  const issueId = getIdPath(payload, "data", "issue", "id");

  if (!issueId) return null;

  const shortId = getStringPath(payload, "data", "issue", "shortId");
  const projectSlug = getStringPath(payload, "data", "issue", "project", "slug");
  const permalink = getStringPath(payload, "data", "issue", "permalink");

  const keys: ObjectStateDelta["keys"] = [{ keyKind: "issue_id", keyValue: issueId }];

  // Sentry renders a short id upper-case (`ALFRED-4F`). Fold the stored KEY to
  // that case so a later reader of free text (#1090 defers it) matches one
  // stored value rather than guessing the author's case; the attribute below
  // keeps the verbatim form, because an attribute reports what the provider
  // said and a key is a lookup identity. Nothing reads this key yet; writing
  // it now costs nothing, because a key is an additive identity fact.
  if (shortId) keys.push({ keyKind: "short_id", keyValue: shortId.toUpperCase() });

  return {
    kind: "issue",
    externalId: issueId,
    nativeState,
    title: getStringPath(payload, "data", "issue", "title"),
    // Store the permalink only when it names THIS issue under the reader the
    // adapter proposes keys with. A body whose `permalink` is absent or in an
    // unrecognized form leaves the row's `url` null: a packed card then names
    // the issue without a link, and identity, state and closure are unaffected
    // because all three ride on the id alone.
    url: permalink && collectSentryIssueIds(permalink).includes(issueId) ? permalink : undefined,
    // A Sentry project is not a repository, so `repo` stays absent and the
    // project slug rides in the attributes beside the two identifiers.
    attributes: {
      issue_id: issueId,
      ...(shortId ? { short_id: shortId } : {}),
      ...(projectSlug ? { project_slug: projectSlug } : {}),
    },
    keys,
  };
}

/**
 * The lifecycle token one typed Sentry event type asserts, or `null` for a
 * no-op. The switch is exhaustive over `EVENT_SOURCE_ENTRIES.sentry.eventTypes`,
 * the same device `sentryDeliveryKey` uses on the ingress half of this one
 * vocabulary (ADR-0097): a ninth Sentry event type does not compile until this
 * file says what lifecycle state it asserts, rather than silently folding to
 * no state at all.
 */
function issueNativeState(
  eventType: EventTypeForSource<"sentry">,
): "unresolved" | "resolved" | "archived" | null {
  switch (eventType) {
    case "issue_created":
    case "issue_unresolved":
      return "unresolved";
    case "issue_resolved":
      return "resolved";
    case "issue_archived":
      return "archived";
    // Assignment moves no lifecycle state, and the other three types are not
    // issue transitions at all. Each is named, not defaulted, so the tail below
    // stays reachable only for a type nobody has classified yet.
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
