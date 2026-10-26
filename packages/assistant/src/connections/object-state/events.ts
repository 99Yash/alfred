import {
  type DeploymentStatus,
  type EventTypeForSource,
  type InboundEventSource,
  type McpHealthObjectTitle,
  type McpHealthObjectUrl,
  type StateCategory,
} from "@alfred/contracts";
import { type GithubPayload, parseGithubEvent } from "../ingress/receipt-schemas";
import { type SentryIssuePayload, sentryIssueEventSchema } from "../ingress/sentry";

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

/** What one read proved. A `null` read mints nothing and never closes a loop (ADR-0048-D). */
export interface VerifiedPullReading {
  status: DeploymentStatus;
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
        title: McpHealthObjectTitle | null;
        url: McpHealthObjectUrl | null;
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

/** The MCP health member. The health producer and the reducer take this, never the union. */
export type ApprovedMcpHealthEvent = Extract<ObjectStateEvent, { provider: "mcp" }>;

/**
 * The one door from a stored receipt body to the fold. For one literal `source`, `eventType` is a
 * bare type of that source, so a stored `<source>.<type>` name does not compile; a caller that
 * holds a stored name narrows it first with `parseEventTypeName`, and a caller that holds a bare
 * `string` narrows it first with `isEventTypeForSource`. `null`: the type folds nothing, or the
 * body is not an object. A generic `S` is tier 5: it compiles with any inbound type and folds
 * nothing at runtime, returning `null`. The switch in each source parser names every declared
 * type, so a new type does not compile until that parser classifies it.
 */
export function parseReceiptEvent<S extends InboundEventSource>(
  source: S,
  eventType: EventTypeForSource<S>,
  raw: unknown,
): ObjectStateEvent | null {
  return receiptParser(source)(eventType, raw);
}

type ReceiptParsers = {
  [S in InboundEventSource]: (
    eventType: EventTypeForSource<S>,
    raw: unknown,
  ) => ObjectStateEvent | null;
};

// A new inbound source fails this `satisfies` until it has a parser.
const RECEIPT_PARSERS = {
  github: githubReceiptEvent,
  sentry: sentryReceiptEvent,
} satisfies ReceiptParsers;

// The indexed return type keeps `source` and `eventType` correlated; a `switch` narrows only `source`.
function receiptParser<S extends InboundEventSource>(source: S): ReceiptParsers[S] {
  return RECEIPT_PARSERS[source];
}

function githubReceiptEvent(
  eventType: EventTypeForSource<"github">,
  raw: unknown,
): ObjectStateEvent | null {
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
      // `parseGithubEvent` returns `null` first for an undeclared type, so no path gets here.
      // The binding keeps the switch exhaustive.
      const _exhaustive: never = event;
      void _exhaustive;

      return null;
    }
  }
}

function sentryReceiptEvent(
  eventType: EventTypeForSource<"sentry">,
  raw: unknown,
): ObjectStateEvent | null {
  const lifecycle = sentryLifecycleEventType(eventType);

  if (!lifecycle) return null;

  const parsed = sentryIssueEventSchema.safeParse(raw);

  return parsed.success ? { provider: "sentry", eventType: lifecycle, payload: parsed.data } : null;
}

/** Exhaustive like `sentryDeliveryKey`: the other types are not lifecycle transitions. */
function sentryLifecycleEventType(
  eventType: EventTypeForSource<"sentry">,
): SentryLifecycleEventType | null {
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
      // A generic `S` can still land here at runtime with another source's type; fold nothing.
      const _exhaustive: never = eventType;
      void _exhaustive;

      return null;
    }
  }
}
