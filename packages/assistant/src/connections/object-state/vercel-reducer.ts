import {
  canonicalizeVercelTargetId,
  enumGuard,
  getStringPath,
  isRecord,
  parseGitBranchRef,
  VERCEL_DEPLOYMENT_OUTCOMES,
  vercelDeploymentOutcome,
  type EventTypeForSource,
} from "@alfred/contracts";
import type { ObjectStateDelta } from "./store";

/**
 * Vercel reducer (#1167). Pure. Folds a verified push, or a verified pull (#1193), into an attempt
 * delta plus a target delta (`owner/repo#branch#environment`), which closes by succession. The push
 * is a GitHub `repository_dispatch`: Vercel writes `client_payload`, and only
 * `repository.full_name` comes from GitHub's envelope. A bare type check, not the exhaustive switch
 * `reduceGithubEvent` uses: this file folds one GitHub type. Action meaning lives in
 * `vercelDeploymentOutcome`, shared with the briefing line. Unproven input folds nothing
 * (ADR-0048-D).
 */
export const VERCEL_DISPATCH_EVENT_TYPE: EventTypeForSource<"github"> = "repository_dispatch";

/** Synthetic verified-pull type (#1193). Only `mintVercelPullReceipt` mints it. */
export const VERCEL_PULL_EVENT_TYPE = "deployment_status" as const;

export function reduceVercelEvent(
  eventType: string,
  action: string | null,
  payload: unknown,
): ObjectStateDelta[] {
  if (eventType === VERCEL_PULL_EVENT_TYPE) return reduceVercelPull(payload);

  if (eventType !== VERCEL_DISPATCH_EVENT_TYPE) return [];

  if (!isRecord(payload)) return [];

  // Re-validate the token: the reducer trusts no caller, not even ingress.
  const token = vercelDeploymentOutcome(action);

  if (!token) return [];

  const clientPayload = isRecord(payload.client_payload) ? payload.client_payload : null;

  if (!clientPayload) return [];

  const deploymentId = getStringPath(clientPayload, "id");

  if (!deploymentId) return [];

  const repoFullName = getStringPath(payload, "repository", "full_name");
  // The deployment's branch, not top-level `branch`: `repository_dispatch` always reports the
  // default branch, so every preview would fold into one target.
  const gitRef = getStringPath(clientPayload, "git", "ref");
  // Arrives as `main`, `refs/heads/main`, or a tag or pull ref. A non-branch ref names no target.
  const branch = gitRef ? parseGitBranchRef(gitRef) : null;
  const environment = getStringPath(clientPayload, "environment");
  const url = getStringPath(clientPayload, "url");
  const projectName = getStringPath(clientPayload, "project", "name");

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

const isVercelDeploymentOutcome = enumGuard(VERCEL_DEPLOYMENT_OUTCOMES);

/**
 * Fold a verified pull (#1193) into the same attempt and target identities as the dispatch, so push
 * and pull share one target row. A pull carries the provider time; a dispatch does not.
 * Re-validates the token and re-derives the target id: no caller is trusted, not even the mint.
 */
function reduceVercelPull(payload: unknown): ObjectStateDelta[] {
  if (!isRecord(payload)) return [];

  const target = isRecord(payload.target) ? payload.target : null;
  const deployment = isRecord(payload.deployment) ? payload.deployment : null;

  if (!target || !deployment) return [];

  const token = getStringPath(deployment, "status");

  if (!isVercelDeploymentOutcome(token)) return [];

  const deploymentId = getStringPath(deployment, "id");

  if (!deploymentId) return [];

  const repoFullName = getStringPath(target, "repoFullName");
  const branch = getStringPath(target, "branch");
  const environment = getStringPath(target, "environment");
  const url = getStringPath(deployment, "url");
  const createdAt = getStringPath(deployment, "createdAt");
  const eventTime = createdAt ? new Date(createdAt) : null;
  const providerEventTime = eventTime && !Number.isNaN(eventTime.getTime()) ? eventTime : null;

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
