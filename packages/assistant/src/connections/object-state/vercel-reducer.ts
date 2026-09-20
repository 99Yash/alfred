import {
  canonicalizeVercelTargetId,
  getStringPath,
  isRecord,
  parseGitBranchRef,
  vercelDeploymentOutcome,
  type EventTypeForSource,
} from "@alfred/contracts";
import type { ObjectStateDelta } from "./store";

/**
 * Vercel reducer (#1167). Pure, idempotent: maps a single verified-push
 * receipt to the projection deltas the store applies. The irreducibly
 * per-provider half, mirroring `reduceCheckSuite` and `reduceRailwayEvent` —
 * a deployment target closes by SUCCESSION (`owner/repo#branch#environment`),
 * so one dispatch folds its attempt delta plus its target delta, and the
 * store's `(providerEventTime, deliveredAt)` ordering keeps the latest read.
 *
 * The receipt is a GitHub `repository_dispatch` delivery. GitHub is only the
 * transport: Vercel authors the `client_payload`, and every field this file
 * asserts comes from there rather than from GitHub's own envelope. The one
 * exception is `repository.full_name`, which is GitHub's and is the only
 * stable repo name the body carries.
 *
 * The type gate below is a bare comparison against a tuple-pinned constant
 * rather than the `isEventTypeForSource` + `_exhaustive: never` device
 * `reduceGithubEvent` uses (ADR-0097). That device is right there because
 * GitHub owns eight event types and each must state its verdict; here an
 * exhaustive switch would force every future GitHub event type to grow a
 * second dead branch in a file that folds exactly one of them. Railway's
 * reducer already refused that cost for the same reason.
 *
 * What each dispatch action MEANS is not decided here: `vercelDeploymentOutcome`
 * in `@alfred/contracts` holds that table, beside the registry entry whose
 * vocabulary it produces, because the briefing activity line reads the same
 * answer. One authority, so a fold and a written line cannot disagree.
 *
 * Anything the payload does not prove folds nothing — absence never closes
 * (ADR-0048-D).
 */
export const VERCEL_DISPATCH_EVENT_TYPE: EventTypeForSource<"github"> = "repository_dispatch";

export function reduceVercelEvent(
  eventType: string,
  action: string | null,
  payload: unknown,
): ObjectStateDelta[] {
  if (eventType !== VERCEL_DISPATCH_EVENT_TYPE) return [];

  if (!isRecord(payload)) return [];

  // Boundary parse: every field off `unknown` with the shared readers, never
  // a cast. The reducer trusts no caller — not even ingress — so the token is
  // re-validated here against the registry vocabulary.
  const token = vercelDeploymentOutcome(action);

  if (!token) return [];

  const clientPayload = isRecord(payload.client_payload) ? payload.client_payload : null;

  if (!clientPayload) return [];

  const deploymentId = getStringPath(clientPayload, "id");

  if (!deploymentId) return [];

  const repoFullName = getStringPath(payload, "repository", "full_name");
  // The DEPLOYMENT's branch, from Vercel's half of the body. NOT the
  // top-level `branch`: `repository_dispatch` always fires against the
  // repository's default branch, so that field reads `main` even for a
  // preview deploy of a feature branch (measured on all 15 dev receipts).
  // Reading it would fold every preview of a repo into one target identity.
  const gitRef = getStringPath(clientPayload, "git", "ref");
  // The dispatcher writes the ref, so it arrives as either `main` or
  // `refs/heads/main`, and a tag or pull ref arrives here too. One branch must
  // reduce to one identity, and a ref that names no branch names no target.
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
    // The deployment id alone: NO target key, so an attempt row never joins a
    // target identity lookup the way a head_sha key would shadow a PR.
    keys: [{ keyKind: "deployment_id", keyValue: deploymentId }],
  };

  // A dispatch whose body names no target still folds its attempt, rather
  // than vanishing — the degradation path both precedents chose.
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
    // Self-key only: the target is read structurally by identity, and a
    // deployment id key here would shadow the attempt it belongs to.
    keys: [{ keyKind: "deployment_target", keyValue: targetId }],
    // No `providerEventTime`, and that is a measured fact rather than an
    // omission: the `client_payload` carries no instant of any kind — its
    // keys are exactly `alias, environment, git, id, project, state, url` on
    // all 15 dev receipts — and `repository_dispatch` has no top-level
    // timestamp. So the store falls back to the receipt clock, which is what
    // `deliveredAt` is for. Ingress already dedups a true redelivery on
    // `(provider, provider_delivery_id)` before the fold sees it twice.
  };

  return [attempt, targetDelta];
}
