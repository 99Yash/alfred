import {
  canonicalizeGithubPullRequestUrl,
  canonicalizeGithubTargetId,
  getIdPath,
  getPath,
  getStringPath,
  isEventTypeForSource,
  isRecord,
} from "@alfred/contracts";
import type { ObjectStateDelta } from "./store";

/**
 * GitHub reducer (ADR-0062). Pure. Webhooks are the only state source, so a model-proposed key can
 * never fake a merge. An empty array is a no-op.
 * - `pull_request`: opened, reopened or synchronize gives `open`; closed gives `merged` or
 *   `closed`. Other actions are no-ops.
 * - `check_suite` (completed only): an attempt delta plus an `owner/repo#branch` target delta,
 *   ordered by the suite's `updated_at` (#1093). `neutral` and `stale` fold nothing.
 */
export function reduceGithubEvent(
  eventType: string,
  action: string | null,
  payload: unknown,
): ObjectStateDelta[] {
  if (!isEventTypeForSource("github", eventType)) return [];

  switch (eventType) {
    case "pull_request":
      return reducePullRequest(action, payload);
    case "check_suite":
      return reduceCheckSuite(action, payload);
    case "push":
    case "issues":
    case "pull_request_review":
      return [];
    // GitHub only transports this. `reduceVercelEvent` folds Vercel's dispatch (#1167).
    case "repository_dispatch":
      return [];
    default: {
      const _exhaustive: never = eventType;

      return _exhaustive;
    }
  }
}

function reducePullRequest(action: string | null, payload: unknown): ObjectStateDelta[] {
  const githubId = getIdPath(payload, "pull_request", "id");

  if (githubId === null) return [];

  // `getIdPath` returns a string; `Number` restores the integer, and the canonicalizer checks it.
  const rawNumber = getIdPath(payload, "pull_request", "number");
  const number = rawNumber === null ? null : Number(rawNumber);
  const nativeState = pullRequestNativeState(action, getPath(payload, "pull_request", "merged"));

  if (nativeState === null) return [];

  const headSha = getStringPath(payload, "pull_request", "head", "sha");
  const headRef = getStringPath(payload, "pull_request", "head", "ref");
  const repoFullName = getStringPath(payload, "repository", "full_name");
  const htmlUrl = getStringPath(payload, "pull_request", "html_url");

  const keys: ObjectStateDelta["keys"] = [];

  if (headSha) keys.push({ keyKind: "head_sha", keyValue: headSha });

  const pullRequestUrl =
    repoFullName && number !== null
      ? canonicalizeGithubPullRequestUrl({ repoFullName, number })
      : htmlUrl
        ? canonicalizeGithubPullRequestUrl({ url: htmlUrl })
        : null;

  if (pullRequestUrl) {
    keys.push({ keyKind: "pull_request_url", keyValue: pullRequestUrl });
  }

  return [
    {
      kind: "pull_request",
      externalId: githubId,
      nativeState,
      closureSource: "verified_push",
      title: getStringPath(payload, "pull_request", "title"),
      url: pullRequestUrl ?? undefined,
      repo: repoFullName ?? undefined,
      attributes: {
        ...(headSha ? { head_sha: headSha } : {}),
        ...(headRef ? { head_ref: headRef } : {}),
        // `githubId` is a validated safe-integer string, so `Number` is exact.
        github_id: Number(githubId),
        ...(number !== null ? { number } : {}),
      },
      keys,
    },
  ];
}

/** PR action plus `merged` to one native-state token. */
function pullRequestNativeState(
  action: string | null,
  merged: unknown,
): "open" | "merged" | "closed" | null {
  switch (action) {
    case "opened":
    case "reopened":
    case "synchronize":
      return "open";
    case "closed":
      return merged === true ? "merged" : "closed";
    default:
      return null;
  }
}

/**
 * Fold a completed suite into an attempt delta and an `owner/repo#branch` target delta. No branch
 * still folds the attempt, which never closes asks. No usable conclusion folds nothing.
 */
function reduceCheckSuite(action: string | null, payload: unknown): ObjectStateDelta[] {
  if (action !== "completed" || !isRecord(payload)) return [];

  const suite = isRecord(payload.check_suite) ? payload.check_suite : null;

  if (!suite) return [];

  const suiteId = getIdPath(payload, "check_suite", "id");

  if (!suiteId) return [];

  const token = checkSuiteNativeState(getStringPath(payload, "check_suite", "conclusion"));

  if (!token) return [];

  const headSha = getStringPath(payload, "check_suite", "head_sha");
  const branch = getStringPath(payload, "check_suite", "head_branch");
  const repoFullName = getStringPath(payload, "repository", "full_name");

  const providerEventTime = parseProviderEventTime(
    getStringPath(payload, "check_suite", "updated_at"),
  );

  const attempt: ObjectStateDelta = {
    kind: "ci_attempt",
    externalId: `check_suite:${suiteId}`,
    nativeState: token,
    closureSource: "verified_push",
    repo: repoFullName ?? undefined,
    attributes: {
      suite_id: suiteId,
      conclusion: token,
      ...(branch ? { head_branch: branch } : {}),
      ...(headSha ? { head_sha: headSha } : {}),
    },
    // No head_sha key, so an attempt row never resolves as the PR.
    keys: [{ keyKind: "check_suite_id", keyValue: suiteId }],
    ...(providerEventTime ? { providerEventTime } : {}),
  };

  if (!repoFullName || !branch) return [attempt];

  const targetId = canonicalizeGithubTargetId({ repoFullName, branch });

  if (!targetId) return [attempt];

  const target: ObjectStateDelta = {
    kind: "ci_target",
    externalId: targetId,
    nativeState: token,
    closureSource: "verified_push",
    repo: repoFullName,
    attributes: {
      suite_id: suiteId,
      conclusion: token,
      head_branch: branch,
      ...(headSha ? { head_sha: headSha } : {}),
    },
    // Self-key only. A head_sha key here would shadow the PR.
    keys: [{ keyKind: "ci_target", keyValue: targetId }],
    ...(providerEventTime ? { providerEventTime } : {}),
  };

  return [attempt, target];
}

/** Suite conclusion to `success` or `failure`. Anything else folds nothing. */
function checkSuiteNativeState(conclusion: string | undefined): "success" | "failure" | null {
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
    case "cancelled":
    case "timed_out":
    case "action_required":
      return "failure";
    default:
      return null;
  }
}

/** The suite's provider time, or `undefined`, so the store falls back to receipt time. */
function parseProviderEventTime(value: string | undefined): Date | undefined {
  if (!value) return undefined;

  const time = new Date(value);

  return Number.isNaN(time.getTime()) ? undefined : time;
}
