import { canonicalizeRailwayTargetId, getIdPath, getStringPath, isRecord } from "@alfred/contracts";
import type { ObjectStateDelta } from "./store";

/**
 * Railway reducer (#1094). Pure. Folds a verified pull into an attempt delta plus a target delta
 * (`projectId/serviceId/environmentId`), which closes by succession. `mintRailwayPullReceipt` is
 * the only minter, so a bare type check is enough. Unproven input folds nothing (ADR-0048-D).
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

  // Re-validate the token: the reducer trusts no caller, not even the mint.
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
    // No target key, so an attempt row never shadows a target lookup.
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
    // Self-key only. A deployment id key here would shadow the attempt.
    keys: [{ keyKind: "deployment_target", keyValue: targetId }],
    ...(providerEventTime ? { providerEventTime } : {}),
  };

  return [attempt, targetDelta];
}

/** Known outcome tokens only. A new token folds nothing until this file classifies it. */
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
