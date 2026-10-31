import {
  assertNever,
  canonicalizeGithubPullRequestUrl,
  canonicalizeGithubTargetId,
} from "@alfred/contracts";
import { GITHUB_MERGED_PULL_READ_EVENT_TYPE, type ObjectStateEvent } from "./events";
import type { ObjectStateDelta } from "./store";

type GithubFoldEvent = Extract<ObjectStateEvent, { provider: "github" }>;

type PullRequestPayload = Extract<GithubFoldEvent, { eventType: "pull_request" }>["payload"];

type CheckSuitePayload = Extract<GithubFoldEvent, { eventType: "check_suite" }>["payload"];

type MergedPullReadPayload = Extract<
  GithubFoldEvent,
  { eventType: typeof GITHUB_MERGED_PULL_READ_EVENT_TYPE }
>["payload"];

/**
 * GitHub reducer (ADR-0062). Pure. Webhooks and the verified read are the only state sources, so a
 * model-proposed key can never fake a merge. An empty array is a no-op.
 * - `pull_request`: opened, reopened or synchronize gives `open`; closed gives `merged` or
 *   `closed`. Other actions are no-ops.
 * - `check_suite` (completed only): an attempt delta plus an `owner/repo#branch` target delta,
 *   ordered by the suite's `updated_at` (#1093). `neutral` and `stale` fold nothing.
 * - `merged_pull_read`: a merge that the GitHub pull read, on a row a webhook minted. It gives
 *   `merged`, ordered by the provider's `merged_at` (ADR-0062 amendment 2026-10-27).
 */
export function reduceGithubEvent(event: GithubFoldEvent): ObjectStateDelta[] {
  switch (event.eventType) {
    case "pull_request":
      return reducePullRequest(event.payload);
    case "check_suite":
      return reduceCheckSuite(event.payload);
    case GITHUB_MERGED_PULL_READ_EVENT_TYPE:
      return reduceMergedPullRead(event.payload);
    default:
      return assertNever(event, "GitHub event type");
  }
}

function reducePullRequest(payload: PullRequestPayload): ObjectStateDelta[] {
  const pr = payload.pull_request;
  const githubId = pr?.id;

  if (githubId === undefined) return [];

  // The id leaf returns a string; `Number` restores the integer, and the canonicalizer checks it.
  const number = pr?.number === undefined ? null : Number(pr.number);
  const nativeState = pullRequestNativeState(payload.action ?? null, pr?.merged);

  if (nativeState === null) return [];

  const headSha = pr?.head?.sha;
  const headRef = pr?.head?.ref;
  const repoFullName = payload.repository?.full_name;
  const htmlUrl = pr?.html_url;

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
      title: pr?.title,
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

/**
 * Only the URL key: the search does not return the pull request id or the head sha. The row
 * keeps the keys and attributes that its webhook wrote.
 */
function reduceMergedPullRead(payload: MergedPullReadPayload): ObjectStateDelta[] {
  return [
    {
      kind: "pull_request",
      externalId: payload.externalId,
      nativeState: "merged",
      closureSource: "verified_pull",
      providerEventTime: payload.mergedAt,
      title: payload.title,
      url: payload.url,
      repo: payload.repoFullName,
      attributes: { number: payload.number },
      keys: [{ keyKind: "pull_request_url", keyValue: payload.url }],
    },
  ];
}

/** PR action plus `merged` to one native-state token. */
function pullRequestNativeState(
  action: string | null,
  merged: boolean | undefined,
): "open" | "merged" | "closed" | null {
  switch (action) {
    case "opened":
    case "reopened":
    case "synchronize":
      return "open";
    case "closed":
      return merged === true ? "merged" : "closed";
    case null:
    default:
      return null;
  }
}

/**
 * Fold a completed suite into an attempt delta and an `owner/repo#branch` target delta. No branch
 * still folds the attempt, which never closes asks. No usable conclusion folds nothing.
 */
function reduceCheckSuite(payload: CheckSuitePayload): ObjectStateDelta[] {
  const suite = payload.check_suite;

  if (payload.action !== "completed" || !suite?.id) return [];

  const suiteId = suite.id;
  const token = checkSuiteNativeState(suite.conclusion);

  if (!token) return [];

  const headSha = suite.head_sha;
  const branch = suite.head_branch;
  const repoFullName = payload.repository?.full_name;
  const providerEventTime = suite.updated_at;

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
    case undefined:
    default:
      return null;
  }
}
