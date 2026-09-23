import { canonicalizeRailwayTargetId, getIdPath, getStringPath, isRecord } from "@alfred/contracts";
import type { ObjectStateDelta } from "./store";

/**
 * Railway reducer (#1094). Pure, idempotent: maps a single verified-pull
 * receipt to the projection deltas the store applies. The irreducibly
 * per-provider half, mirroring `reduceCheckSuite` — a deployment target
 * closes by SUCCESSION (`projectId/serviceId/environmentId`), so one pull
 * folds its attempt delta plus its target delta, and the store's
 * `(providerEventTime, deliveredAt)` ordering keeps the latest read.
 *
 * The pull receipt is SYNTHETIC: `mintRailwayPullReceipt`
 * (`verified-pull/railway.ts`) is its only minter, and there is no webhook, no
 * descriptor, and no external
 * producer that could add a second type. So the type gate below is a bare
 * comparison, not the `isEventTypeForSource` + `_exhaustive: never` device the
 * delivery vocabularies need (ADR-0097): there is no ninth type to force.
 * Anything the receipt does not prove folds nothing — absence never closes
 * (ADR-0048-D).
 */
export const RAILWAY_PULL_EVENT_TYPE = "deployment_status" as const;

export function reduceRailwayEvent(
  eventType: string,
  _action: string | null,
  payload: unknown,
): ObjectStateDelta[] {
  if (eventType !== RAILWAY_PULL_EVENT_TYPE) return [];

  if (!isRecord(payload)) return [];

  const target = isRecord(payload.target) ? payload.target : null;
  const deployment = isRecord(payload.deployment) ? payload.deployment : null;

  if (!target || !deployment) return [];

  // Boundary parse: every field off `unknown` with the shared readers, never
  // a cast. The reducer trusts no caller — not even the mint — so the token
  // is re-validated here against the registry vocabulary.
  const token = pullNativeState(getStringPath(deployment, "status"));

  if (!token) return [];

  const deploymentId = getIdPath(deployment, "id");

  if (!deploymentId) return [];

  const projectId = getStringPath(target, "projectId");
  const serviceId = getStringPath(target, "serviceId");
  const environmentId = getStringPath(target, "environmentId");

  const targetId = canonicalizeRailwayTargetId({
    projectId: projectId ?? "",
    serviceId: serviceId ?? "",
    environmentId: environmentId ?? "",
  });

  const providerEventTime = parsePullEventTime(getStringPath(deployment, "createdAt"));
  const url = getStringPath(deployment, "url");

  const attempt: ObjectStateDelta = {
    kind: "deployment_attempt",
    externalId: `deployment:${deploymentId}`,
    nativeState: token,
    closureSource: "verified_pull",
    attributes: {
      deployment_id: deploymentId,
      status: token,
    },
    // The deployment id alone: NO target key, so an attempt row never joins
    // a target identity lookup the way a head_sha key would shadow a PR.
    keys: [{ keyKind: "deployment_id", keyValue: deploymentId }],
  };

  if (!targetId) return [attempt];

  const targetDelta: ObjectStateDelta = {
    kind: "deployment_target",
    externalId: targetId,
    nativeState: token,
    closureSource: "verified_pull",
    url: url ?? undefined,
    attributes: {
      deployment_id: deploymentId,
      status: token,
      ...(projectId ? { project_id: projectId } : {}),
      ...(serviceId ? { service_id: serviceId } : {}),
      ...(environmentId ? { environment_id: environmentId } : {}),
    },
    // Self-key only: the target is read structurally by identity, and a
    // deployment id key here would shadow the attempt it belongs to.
    keys: [{ keyKind: "deployment_target", keyValue: targetId }],
    ...(providerEventTime ? { providerEventTime } : {}),
  };

  return [attempt, targetDelta];
}

/**
 * Collapse the pull-collapsed outcome token into the registry vocabulary. The
 * seam already collapses Railway API statuses to these three; an anything
 * else here — including a future fourth token the seam starts passing —
 * folds nothing until this file says what lifecycle state it asserts.
 */
function pullNativeState(token: string | undefined): "success" | "failure" | "pending" | null {
  switch (token) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "pending":
      return "pending";
    default:
      return null;
  }
}

function parsePullEventTime(value: string | undefined): Date | undefined {
  if (!value) return undefined;

  const time = new Date(value);

  return Number.isNaN(time.getTime()) ? undefined : time;
}
