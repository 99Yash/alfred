import {
  assertNever,
  canonicalizeVercelTargetId,
  parseGitBranchRef,
  vercelDeploymentOutcome,
} from "@alfred/contracts";
import type { ObjectStateEvent } from "./events";
import type { ObjectStateDelta } from "./store";

type VercelFoldEvent = Extract<ObjectStateEvent, { provider: "vercel" }>;

type DispatchPayload = Extract<VercelFoldEvent, { eventType: "repository_dispatch" }>["payload"];

type PullPayload = Extract<VercelFoldEvent, { eventType: "deployment_status" }>["payload"];

/**
 * Vercel reducer (#1167). Pure. Folds a verified push, or a verified pull (#1193), into an attempt
 * delta plus a target delta (`owner/repo#branch#environment`), which closes by succession. The push
 * is a GitHub `repository_dispatch`: Vercel writes `client_payload`, and only
 * `repository.full_name` comes from GitHub's envelope. Action and detail meaning live in
 * `vercelDeploymentOutcome`, shared with the briefing line. Unproven input folds nothing
 * (ADR-0048-D).
 */
export function reduceVercelEvent(event: VercelFoldEvent): ObjectStateDelta[] {
  switch (event.eventType) {
    case "repository_dispatch":
      return reduceVercelDispatch(event.payload);
    case "deployment_status":
      return reduceVercelPull(event.payload);
    default:
      return assertNever(event, "Vercel event type");
  }
}

function reduceVercelDispatch(payload: DispatchPayload): ObjectStateDelta[] {
  const clientPayload = payload.client_payload;
  // A deletion folds nothing.
  const token = vercelDeploymentOutcome(payload.action, clientPayload?.state?.detail);

  if (!token) return [];

  const deploymentId = clientPayload?.id;

  if (!deploymentId) return [];

  const repoFullName = payload.repository?.full_name;
  // The deployment's branch, not top-level `branch`: `repository_dispatch` always reports the
  // default branch, so every preview would fold into one target.
  const gitRef = clientPayload.git?.ref;
  // Arrives as `main`, `refs/heads/main`, or a tag or pull ref. A non-branch ref names no target.
  const branch = gitRef ? parseGitBranchRef(gitRef) : null;
  const environment = clientPayload.environment;
  const url = clientPayload.url;
  const projectName = clientPayload.project?.name;

  const attempt: ObjectStateDelta = {
    kind: "deployment_attempt",
    externalId: `deployment:${deploymentId}`,
    nativeState: token,
    closureSource: "verified_push",
    ...(url ? { url } : {}),
    ...(repoFullName ? { repo: repoFullName } : {}),
    attributes: {
      deployment_id: deploymentId,
      status: token,
      ...(environment ? { environment } : {}),
      ...(projectName ? { project_name: projectName } : {}),
    },
    // No target key, so an attempt row never shadows a target lookup.
    keys: [{ keyKind: "deployment_id", keyValue: deploymentId }],
  };

  // No target in the body: still fold the attempt.
  if (!repoFullName || !branch || !environment) return [attempt];

  const targetId = canonicalizeVercelTargetId({ repoFullName, branch, environment });

  if (!targetId) return [attempt];

  const targetDelta: ObjectStateDelta = {
    kind: "deployment_target",
    externalId: targetId,
    nativeState: token,
    closureSource: "verified_push",
    ...(url ? { url } : {}),
    repo: repoFullName,
    attributes: {
      deployment_id: deploymentId,
      status: token,
      branch,
      environment,
      ...(projectName ? { project_name: projectName } : {}),
    },
    // Self-key only. A deployment id key here would shadow the attempt.
    keys: [{ keyKind: "deployment_target", keyValue: targetId }],
    // No `providerEventTime`: `client_payload` carries no timestamp and the dispatch has none, so
    // the store orders by receipt time.
  };

  return [attempt, targetDelta];
}

/**
 * Fold a verified pull (#1193) into the same attempt and target identities as the dispatch, so push
 * and pull share one target row. A pull carries the provider time; a dispatch does not.
 * Re-derives the target id: the canonical form is a runtime fact, not a type.
 */
function reduceVercelPull({ target, reading }: PullPayload): ObjectStateDelta[] {
  const token = reading.status;
  const deploymentId = reading.attemptId;

  if (!deploymentId) return [];

  const { repoFullName, branch, environment } = target;
  const url = reading.url;
  const providerEventTime = reading.providerEventTime;

  const attempt: ObjectStateDelta = {
    kind: "deployment_attempt",
    externalId: `deployment:${deploymentId}`,
    nativeState: token,
    closureSource: "verified_pull",
    ...(url ? { url } : {}),
    ...(repoFullName ? { repo: repoFullName } : {}),
    attributes: {
      deployment_id: deploymentId,
      status: token,
      ...(environment ? { environment } : {}),
    },
    keys: [{ keyKind: "deployment_id", keyValue: deploymentId }],
  };

  if (!repoFullName || !branch || !environment) return [attempt];

  const targetId = canonicalizeVercelTargetId({ repoFullName, branch, environment });

  if (!targetId) return [attempt];

  const targetDelta: ObjectStateDelta = {
    kind: "deployment_target",
    externalId: targetId,
    nativeState: token,
    closureSource: "verified_pull",
    ...(url ? { url } : {}),
    repo: repoFullName,
    attributes: {
      deployment_id: deploymentId,
      status: token,
      branch,
      environment,
    },
    keys: [{ keyKind: "deployment_target", keyValue: targetId }],
    ...(providerEventTime ? { providerEventTime } : {}),
  };

  return [attempt, targetDelta];
}
