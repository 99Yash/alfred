import {
  collapseWhitespace,
  isEventTypeForSource,
  parseGitBranchRef,
  vercelDeploymentOutcome,
  type EventTypeForSource,
} from "@alfred/contracts";
import { z } from "zod";
import type { InboundDescription } from "./descriptor";
import { describeInboundJson } from "./description";

/**
 * The slice of a GitHub webhook body the activity line reads. The body is
 * persisted as `event_receipts.payload` (jsonb, typed `unknown` on read), so
 * this is the owning boundary that validates it. Every field is optional: an
 * older or partial delivery still yields a generic line, never an error.
 */
const githubWebhookPayloadSchema = z.object({
  action: z.string().optional(),
  ref: z.string().optional(),
  commits: z.array(z.unknown()).optional(),
  compare: z.string().optional(),
  pull_request: z
    .object({
      number: z.number().optional(),
      title: z.string().optional(),
      html_url: z.string().optional(),
      merged: z.boolean().optional(),
    })
    .optional(),
  issue: z
    .object({
      number: z.number().optional(),
      title: z.string().optional(),
      html_url: z.string().optional(),
    })
    .optional(),
  repository: z
    .object({ full_name: z.string().optional(), html_url: z.string().optional() })
    .optional(),
  review: z.object({ state: z.string().optional(), html_url: z.string().optional() }).optional(),
  check_suite: z
    .object({
      conclusion: z.string().optional(),
      head_branch: z.string().optional(),
      status: z.string().optional(),
    })
    .optional(),
  /**
   * `repository_dispatch` carries a dispatcher-authored body. Vercel is the
   * only dispatcher this build reads (#1167); every field stays optional, so
   * another dispatcher's body still yields a generic line rather than an
   * error.
   */
  client_payload: z
    .object({
      url: z.string().optional(),
      environment: z.string().optional(),
      git: z.object({ ref: z.string().optional() }).optional(),
      project: z.object({ name: z.string().optional() }).optional(),
    })
    .optional(),
});

type GithubWebhookPayload = z.infer<typeof githubWebhookPayloadSchema>;

function describeGithubActivity(
  eventType: EventTypeForSource<"github">,
  action: string | null,
  repo: string | null,
  payload: GithubWebhookPayload,
): Pick<InboundDescription, "title" | "status" | "url"> {
  const where = repo ? ` in ${repo}` : "";

  switch (eventType) {
    case "pull_request": {
      const pr = payload.pull_request ?? {};
      const verb = action === "closed" ? (pr.merged ? "merged" : "closed") : (action ?? "updated");
      const title = `PR #${pr.number ?? "?"} ${verb}${where}${pr.title ? `: ${pr.title}` : ""}`;

      return { title, status: action === "closed" ? "resolved" : "open", url: pr.html_url };
    }

    case "issues": {
      const issue = payload.issue ?? {};
      const title = `Issue #${issue.number ?? "?"} ${action ?? "updated"}${where}${issue.title ? `: ${issue.title}` : ""}`;

      return { title, status: action === "closed" ? "resolved" : "open", url: issue.html_url };
    }

    case "push": {
      const count = Array.isArray(payload.commits) ? payload.commits.length : 0;
      const branch = (payload.ref ?? "").replace("refs/heads/", "");
      const title = `${count} commit${count === 1 ? "" : "s"} pushed${branch ? ` to ${branch}` : ""}${where}`;

      return { title, url: payload.compare };
    }

    case "pull_request_review": {
      const pr = payload.pull_request ?? {};
      const title = `PR #${pr.number ?? "?"} ${payload.review?.state ?? "reviewed"}${where}`;

      return { title, status: "open", url: payload.review?.html_url ?? pr.html_url };
    }

    case "check_suite": {
      const suite = payload.check_suite ?? {};
      const outcome = suite.conclusion ?? suite.status ?? action ?? "updated";
      const branch = suite.head_branch ? ` on ${suite.head_branch}` : "";
      const title = `Check suite ${outcome}${branch}${where}`;

      return { title, status: action === "completed" ? "resolved" : "open", url: undefined };
    }

    case "repository_dispatch": {
      // What the action MEANS comes from the one table the vercel reducer
      // folds with, never from a second copy written here. An action that
      // table does not carry belongs to some other dispatcher: the line stays
      // generic and the status stays `open`, the same default every arm above
      // uses. An unrecognized dispatch must never read as a green deploy.
      const outcome = vercelDeploymentOutcome(action ?? null);

      if (!outcome) return { title: `Repository dispatch${where}`, status: "open", url: undefined };

      const deployment = payload.client_payload ?? {};
      // Display only, and it carries no authority: the action suffix says
      // `ready` or `promoted` where the folded outcome says only `success`,
      // and the reader deserves the finer word.
      const said = action?.replace(/^vercel\.deployment\./, "") ?? outcome;
      // The DEPLOYMENT's branch. The top-level `ref`/`branch` of a
      // `repository_dispatch` is always the default branch, so it would read
      // `main` for a preview deploy of any feature branch.
      //
      // How a branch ref is spelled is decided ONCE, in contracts, so this
      // line reads the same branch the reducer folds on rather than a second
      // reading of the same field. A ref that names no branch (a tag, a pull
      // ref) has no branch to show, so the raw ref stands.
      const gitRef = deployment.git?.ref;
      const branch = gitRef ? ` on ${parseGitBranchRef(gitRef) ?? gitRef}` : "";
      const environment = deployment.environment ? ` (${deployment.environment})` : "";

      return {
        title: `Deployment ${said}${branch}${environment}${where}`,
        // The activity-status vocabulary carries a `succeeded` member and a
        // `failed` member, so a deployment says which one it is rather than
        // borrowing the PR lane's `resolved`.
        status: outcome === "failure" ? "failed" : outcome === "success" ? "succeeded" : "open",
        url: deployment.url,
      };
    }

    default: {
      const exhaustive: never = eventType;

      return exhaustive;
    }
  }
}

export function describeGithubReceipt(kind: string, raw: unknown): InboundDescription {
  const fallback = describeInboundJson("github", kind, raw);

  if (!isEventTypeForSource("github", kind)) return fallback;
  const parsed = githubWebhookPayloadSchema.safeParse(raw);
  const payload = parsed.success ? parsed.data : {};

  const activity = describeGithubActivity(
    kind,
    payload.action ?? null,
    payload.repository?.full_name ?? null,
    payload,
  );

  return {
    ...fallback,
    ...activity,
    url: activity.url ?? fallback.url,
    summary: collapseWhitespace(activity.title),
    body: `${activity.title}\n${fallback.body}`,
  };
}
