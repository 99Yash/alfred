import { isRecord } from "@alfred/contracts";
import type { ObjectStateDelta } from "./store";

/**
 * GitHub reducer (ADR-0062, #212). Pure, idempotent: maps a single
 * `pull_request` webhook delivery to the projection delta the store applies.
 * The irreducibly per-provider half — there is no generic reducer; "cross-
 * integration" means generic *schema + interface*, per-provider *reducers*.
 *
 * State source of truth is the webhook ONLY (the propose/dispose invariant):
 * the native-state token is collapsed here from the PR's `state` + `merged`
 * boolean into one of `open | merged | closed`, which the registry's
 * `normalize` maps to the agnostic category. An LLM-proposed key can never
 * reach this path, so it can never fake a merge.
 *
 * Only the actions that carry `head.sha` and move lifecycle state emit a delta:
 *   opened / reopened / synchronize → `open`   (+ head_sha key)
 *   closed (merged=true)            → `merged`
 *   closed (merged=false)           → `closed`
 * Everything else (labeled, edited, review_requested, …) is a no-op (`null`).
 */
export function reduceGithubEvent(
  eventType: string,
  action: string | null,
  payload: unknown,
): ObjectStateDelta | null {
  if (eventType !== "pull_request") return null;
  if (!isRecord(payload)) return null;

  const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
  if (!pr) return null;

  const githubId = typeof pr.id === "number" ? pr.id : null;
  if (githubId === null) return null;
  const number = typeof pr.number === "number" ? pr.number : null;

  const nativeState = pullRequestNativeState(action, pr);
  if (nativeState === null) return null;

  const head = isRecord(pr.head) ? pr.head : null;
  const headSha = head && typeof head.sha === "string" ? head.sha : null;
  const headRef = head && typeof head.ref === "string" ? head.ref : null;

  const repo = isRecord(payload.repository) ? payload.repository : null;
  const repoFullName = repo && typeof repo.full_name === "string" ? repo.full_name : null;

  const keys: ObjectStateDelta["keys"] = [];
  if (headSha) keys.push({ keyKind: "head_sha", keyValue: headSha });

  return {
    kind: "pull_request",
    externalId: String(githubId),
    nativeState,
    title: typeof pr.title === "string" ? pr.title : undefined,
    url: typeof pr.html_url === "string" ? pr.html_url : undefined,
    repo: repoFullName ?? undefined,
    attributes: {
      ...(headSha ? { head_sha: headSha } : {}),
      ...(headRef ? { head_ref: headRef } : {}),
      github_id: githubId,
      ...(number !== null ? { number } : {}),
    },
    keys,
  };
}

/** Collapse the PR `state` + `merged` boolean into one native-state token. */
function pullRequestNativeState(
  action: string | null,
  pr: Record<string, unknown>,
): "open" | "merged" | "closed" | null {
  switch (action) {
    case "opened":
    case "reopened":
    case "synchronize":
      return "open";
    case "closed":
      return pr.merged === true ? "merged" : "closed";
    default:
      return null;
  }
}
