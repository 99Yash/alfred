import {
  type InboundEventSource,
  isEventTypeForSource,
  type StateCategory,
} from "@alfred/contracts";
import {
  type GithubPayload,
  parseGithubEvent,
  type SentryIssuePayload,
  sentryIssueEventSchema,
} from "../ingress/receipt-schemas";

/**
 * The fold input (ADR-0062): one member per (provider, event type), each with a typed payload. A
 * stored receipt enters through {@link parseReceiptEvent}. A verified pull and an MCP health read
 * build their member in process.
 */

/** Synthetic verified-pull type for both Railway (#1094) and Vercel (#1193). */
export const VERIFIED_PULL_EVENT_TYPE = "deployment_status";

/** The one synthetic event an owner-reviewed MCP health pull may fold. */
export const MCP_APPROVED_HEALTH_EVENT_TYPE = "mcp.approved_health";

const MAX_CONNECTION_ID_LENGTH = 128;

const MAX_LOOP_KEY_LENGTH = 512;

declare const approvedMcpHealthExternalIdBrand: unique symbol;

/** `connectionId|loopKey`. Branded, so an MCP event can only carry an id this file checked. */
export type ApprovedMcpHealthExternalId = string & {
  readonly [approvedMcpHealthExternalIdBrand]: true;
};

/**
 * Namespace a loop key by its connection, so two services that both return `ENG-123` stay separate.
 */
export function approvedMcpHealthExternalId(input: {
  connectionId: string;
  loopKey: string;
}): ApprovedMcpHealthExternalId | null {
  if (
    input.connectionId.length === 0 ||
    input.connectionId.length > MAX_CONNECTION_ID_LENGTH ||
    input.loopKey.length === 0 ||
    input.loopKey.length > MAX_LOOP_KEY_LENGTH ||
    input.connectionId.includes("|") ||
    input.loopKey.includes("|")
  ) {
    return null;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand's mint, after the length and separator checks
  return `${input.connectionId}|${input.loopKey}` as ApprovedMcpHealthExternalId;
}

export type SentryLifecycleEventType =
  | "issue_created"
  | "issue_unresolved"
  | "issue_resolved"
  | "issue_archived";

export type VerifiedPullStatus = "success" | "failure" | "pending";

/** What one read proved. A `null` read mints nothing and never closes a loop (ADR-0048-D). */
export interface VerifiedPullReading {
  status: VerifiedPullStatus;
  /** The dedup key, such as a deployment id. */
  attemptId: string;
  providerEventTime: Date | null;
  url: string | null;
}

export type ObjectStateEvent =
  | { provider: "github"; eventType: "pull_request"; payload: GithubPayload<"pull_request"> }
  | { provider: "github"; eventType: "check_suite"; payload: GithubPayload<"check_suite"> }
  | {
      provider: "vercel";
      eventType: "repository_dispatch";
      payload: GithubPayload<"repository_dispatch">;
    }
  | {
      provider: "vercel";
      eventType: typeof VERIFIED_PULL_EVENT_TYPE;
      payload: {
        target: { repoFullName: string; branch: string; environment: string };
        reading: VerifiedPullReading;
      };
    }
  | {
      provider: "railway";
      eventType: typeof VERIFIED_PULL_EVENT_TYPE;
      payload: {
        target: { projectId: string; serviceId: string; environmentId: string };
        reading: VerifiedPullReading;
      };
    }
  | { provider: "sentry"; eventType: SentryLifecycleEventType; payload: SentryIssuePayload }
  | {
      provider: "mcp";
      eventType: typeof MCP_APPROVED_HEALTH_EVENT_TYPE;
      payload: {
        externalId: ApprovedMcpHealthExternalId;
        state: StateCategory;
        title: string | null;
        url: string | null;
      };
    };

export type VerifiedPullEvent = Extract<
  ObjectStateEvent,
  { eventType: typeof VERIFIED_PULL_EVENT_TYPE }
>;

/** The Railway member of the pull union. The Railway provider is generic over this, never the union. */
export type RailwayPullEvent = Extract<VerifiedPullEvent, { provider: "railway" }>;

/** The Vercel member of the pull union. The Vercel provider is generic over this, never the union. */
export type VercelPullEvent = Extract<VerifiedPullEvent, { provider: "vercel" }>;

/**
 * The one door from a stored receipt body to the fold. `null`: the type folds nothing, or the body
 * is not an object. Each switch names every declared type, so a new type does not compile until it
 * is classified here.
 */
export function parseReceiptEvent(
  source: InboundEventSource,
  eventType: string,
  raw: unknown,
): ObjectStateEvent | null {
  switch (source) {
    case "github":
      return githubReceiptEvent(eventType, raw);
    case "sentry":
      return sentryReceiptEvent(eventType, raw);
    default: {
      const _exhaustive: never = source;

      return _exhaustive;
    }
  }
}

function githubReceiptEvent(eventType: string, raw: unknown): ObjectStateEvent | null {
  const event = parseGithubEvent(eventType, raw);

  if (!event) return null;

  switch (event.eventType) {
    case "pull_request":
    case "check_suite":
      return { provider: "github", ...event };
    // GitHub only transports Vercel's dispatch (#1167).
    case "repository_dispatch":
      return { provider: "vercel", ...event };
    case "push":
    case "issues":
    case "pull_request_review":
      return null;
    default: {
      const _exhaustive: never = event;

      return _exhaustive;
    }
  }
}

function sentryReceiptEvent(eventType: string, raw: unknown): ObjectStateEvent | null {
  const lifecycle = sentryLifecycleEventType(eventType);

  if (!lifecycle) return null;

  const parsed = sentryIssueEventSchema.safeParse(raw);

  return parsed.success ? { provider: "sentry", eventType: lifecycle, payload: parsed.data } : null;
}

/** Exhaustive like `sentryDeliveryKey`: the other types are not lifecycle transitions. */
function sentryLifecycleEventType(eventType: string): SentryLifecycleEventType | null {
  if (!isEventTypeForSource("sentry", eventType)) return null;

  switch (eventType) {
    case "issue_created":
    case "issue_unresolved":
    case "issue_resolved":
    case "issue_archived":
      return eventType;
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
