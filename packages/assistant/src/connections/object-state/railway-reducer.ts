import { canonicalizeRailwayTargetId } from "@alfred/contracts";
import type { ObjectStateEvent } from "./events";
import type { ObjectStateDelta } from "./store";

/**
 * Railway reducer (#1094). Pure. Folds a verified pull into an attempt delta plus a target delta
 * (`projectId/serviceId/environmentId`), which closes by succession. The pull minter is the only
 * producer. Unproven input folds nothing (ADR-0048-D).
 */
export function reduceRailwayEvent({
  payload: { target, reading },
}: Extract<ObjectStateEvent, { provider: "railway" }>): ObjectStateDelta[] {
  const token = reading.status;
  const deploymentId = reading.attemptId;

  if (!deploymentId) return [];

  const { projectId, serviceId, environmentId } = target;
  const targetId = canonicalizeRailwayTargetId({ projectId, serviceId, environmentId });
  const providerEventTime = reading.providerEventTime;
  const url = reading.url;

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
