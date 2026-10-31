import {
  assertNever,
  collapseWhitespace,
  isEventTypeForSource,
  isVercelDeploymentDeletion,
  parseGitBranchRef,
  vercelDeploymentOutcome,
  type DeploymentStatus,
} from "@alfred/contracts";
import type { InboundDescription } from "./descriptor";
import { describeInboundJson } from "./description";
import { type GithubEvent, parseGithubEvent } from "./receipt-schemas";

const DISPATCH_STATUS_BY_OUTCOME = {
  success: "succeeded",
  failure: "failed",
  pending: "open",
} as const satisfies Record<DeploymentStatus, InboundDescription["status"]>;

function describeGithubActivity(
  event: GithubEvent,
): Pick<InboundDescription, "title" | "status" | "url"> {
  const action = event.payload.action ?? null;
  const repo = event.payload.repository?.full_name;
  const where = repo ? ` in ${repo}` : "";

  switch (event.eventType) {
    case "pull_request": {
      const pr = event.payload.pull_request;
      const verb = action === "closed" ? (pr?.merged ? "merged" : "closed") : (action ?? "updated");
      const title = `PR #${pr?.number ?? "?"} ${verb}${where}${pr?.title ? `: ${pr.title}` : ""}`;

      return { title, status: action === "closed" ? "resolved" : "open", url: pr?.html_url };
    }

    case "issues": {
      const issue = event.payload.issue;
      const title = `Issue #${issue?.number ?? "?"} ${action ?? "updated"}${where}${issue?.title ? `: ${issue.title}` : ""}`;

      return { title, status: action === "closed" ? "resolved" : "open", url: issue?.html_url };
    }

    case "push": {
      const count = event.payload.commits?.length ?? 0;
      const branch = (event.payload.ref ?? "").replace("refs/heads/", "");
      const title = `${count} commit${count === 1 ? "" : "s"} pushed${branch ? ` to ${branch}` : ""}${where}`;

      return { title, url: event.payload.compare };
    }

    case "pull_request_review": {
      const pr = event.payload.pull_request;
      const review = event.payload.review;
      const title = `PR #${pr?.number ?? "?"} ${review?.state ?? "reviewed"}${where}`;

      return { title, status: "open", url: review?.html_url ?? pr?.html_url };
    }

    case "check_suite": {
      const suite = event.payload.check_suite;
      const outcome = suite?.conclusion ?? suite?.status ?? action ?? "updated";
      const branch = suite?.head_branch ? ` on ${suite.head_branch}` : "";
      const title = `Check suite ${outcome}${branch}${where}`;

      return { title, status: action === "completed" ? "resolved" : "open", url: undefined };
    }

    case "repository_dispatch": {
      const deployment = event.payload.client_payload ?? {};
      const detail = deployment.state?.detail;
      // Same table the reducer uses. An unknown action stays `open`, never green.
      const outcome = vercelDeploymentOutcome(action, detail);
      // A deletion is retention, not a verdict, so it gets a line but no status.
      const deleted = isVercelDeploymentDeletion(action, detail);

      if (!outcome && !deleted) {
        return { title: `Repository dispatch${where}`, status: "open", url: undefined };
      }

      // Display only: `ready` or `promoted` is finer than `success`.
      const said = deleted ? "deleted" : (action ?? "").replace(/^vercel\.deployment\./, "");
      // The deployment's branch: a dispatch's top-level `ref` is always the default branch.
      // A ref that names no branch (a tag) shows raw.
      const gitRef = deployment.git?.ref;
      const branch = gitRef ? ` on ${parseGitBranchRef(gitRef) ?? gitRef}` : "";
      const environment = deployment.environment ? ` (${deployment.environment})` : "";

      return {
        title: `Deployment ${said}${branch}${environment}${where}`,
        status: outcome ? DISPATCH_STATUS_BY_OUTCOME[outcome] : undefined,
        url: deployment.url,
      };
    }

    default:
      return assertNever(event, "GitHub event type");
  }
}

export function describeGithubReceipt(kind: string, raw: unknown): InboundDescription {
  const fallback = describeInboundJson("github", kind, raw);

  if (!isEventTypeForSource("github", kind)) return fallback;
  // A pruned body is NULL. It still gets the event line, read from an empty body.
  const event = parseGithubEvent(kind, raw ?? {});

  if (!event) return fallback;
  const activity = describeGithubActivity(event);

  return {
    ...fallback,
    ...activity,
    url: activity.url ?? fallback.url,
    summary: collapseWhitespace(activity.title),
    body: `${activity.title}\n${fallback.body}`,
  };
}
