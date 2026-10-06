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
 * GitHub reducer (ADR-0062, #212). Pure, idempotent: maps a single webhook
 * delivery to the projection deltas the store applies in one transaction
 * (ADR-0103 blesses one receipt yielding zero or several deltas). An empty
 * array is the no-op.
 *
 * State source of truth is the webhook ONLY (the propose/dispose invariant):
 * the native-state token is collapsed here — the PR's `state` + `merged`
 * boolean into one of `open | merged | closed`, a suite's `conclusion` into
 * one of `success | failure | pending` — which the registry's per-kind
 * `normalize` maps to the agnostic category. An LLM-proposed key can never
 * reach this path, so it can never fake a merge.
 *
 * Two shapes, one transaction:
 *   pull_request      → one delta for the PR itself (transition on itself):
 *     opened / reopened / synchronize → `open`   (+ head_sha key)
 *     closed (merged=true)            → `merged`
 *     closed (merged=false)           → `closed`
 *     Everything else (labeled, edited, review_requested, …) is a no-op.
 *   check_suite       → two deltas (succession on a target, #1093): the
 *     attempt row (`ci_attempt`, `check_suite:<id>`) plus the target row
 *     (`ci_target`, `owner/repo#branch`) carrying the same token and the
 *     suite's `updated_at` as the provider-clock instant. Only the
 *     `completed` action carries a conclusion; every other action is a no-op,
 *     and so is a conclusion that names no outcome (`neutral`, `stale`).
 *     `check_run` never reaches this switch: it is not a typed event, so the
 *     ingress guard answers `[]` before the call — the suite subsumes branch
 *     health in v1.
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
    // GitHub is only the TRANSPORT for a `repository_dispatch`: the body's
    // `client_payload` belongs to whoever dispatched it. Vercel's deployment
    // relay is folded by `reduceVercelEvent` under provider `vercel`, so this
    // reducer — GitHub's own half — asserts nothing about it (#1167).
    case "repository_dispatch":
      return [];
    default: {
      const _exhaustive: never = eventType;

      return _exhaustive;
    }
  }
}

function reducePullRequest(action: string | null, payload: unknown): ObjectStateDelta[] {
  // Boundary reads, the way every sibling reducer reads its own provider body:
  // `getIdPath` / `getStringPath` off the raw `unknown` payload, so each field
  // carries its own contract and no parse step can widen the rest back to
  // `JsonObject`.
  const githubId = getIdPath(payload, "pull_request", "id");

  if (githubId === null) return [];

  // GitHub serializes the PR number as a JSON integer. `getIdPath` collapses
  // either spelling to one string; `Number` restores the integer the URL
  // canonicalizer takes, and that canonicalizer is what re-checks it is a safe
  // integer of at least 1.
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
        // The stored attribute keeps its numeric spelling; only the projection
        // identity is text. `githubId` is already a validated safe-integer
        // string, so `Number` is exact.
        github_id: Number(githubId),
        ...(number !== null ? { number } : {}),
      },
      keys,
    },
  ];
}

/** Collapse the PR `state` + `merged` boolean into one native-state token. */
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
 * Fold one completed suite into its attempt delta plus its target delta. The
 * attempt identity is the suite id; the target identity is `owner/repo#branch`.
 * A receipt with no branch still folds its attempt (attempt rows never close
 * asks, so that is inert); a receipt with no usable conclusion folds nothing —
 * absence never closes.
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
    // The suite id alone: NO head_sha key, so an attempt row never joins the
    // PR annotation floor (`byObjectId.size === 1` still sees GitHub-only
    // chunks exactly as before).
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
    // Self-key only: the target is read structurally by identity in v1, and a
    // head_sha key here would shadow the PR the sha belongs to.
    keys: [{ keyKind: "ci_target", keyValue: targetId }],
    ...(providerEventTime ? { providerEventTime } : {}),
  };

  return [attempt, target];
}

/**
 * Collapse a suite conclusion into the CI token vocabulary. `success` resolves
 * the target, the failure family fails it, and a conclusion that names no
 * outcome — plus anything unrecognized — folds nothing.
 */
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

/**
 * Read the suite's provider-clock instant. A missing or unparseable timestamp
 * yields `undefined` — the store then orders by the receipt clock — and never
 * a smuggled null.
 */
function parseProviderEventTime(value: string | undefined): Date | undefined {
  if (!value) return undefined;

  const time = new Date(value);

  return Number.isNaN(time.getTime()) ? undefined : time;
}
