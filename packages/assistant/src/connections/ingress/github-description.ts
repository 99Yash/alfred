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

/** All optional, so a partial delivery still gets a generic line. */
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
  /** `repository_dispatch` body. Only Vercel's is read (#1167). */
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
      // Same table the reducer uses. An unknown action stays `open`, never green.
      const outcome = vercelDeploymentOutcome(action ?? null);

      if (!outcome) return { title: `Repository dispatch${where}`, status: "open", url: undefined };

      const deployment = payload.client_payload ?? {};
      // Display only: `ready` or `promoted` is finer than `success`.
      const said = action?.replace(/^vercel\.deployment\./, "") ?? outcome;
      // The deployment's branch: a dispatch's top-level `ref` is always the default branch.
      // A ref that names no branch (a tag) shows raw.
      const gitRef = deployment.git?.ref;
      const branch = gitRef ? ` on ${parseGitBranchRef(gitRef) ?? gitRef}` : "";
      const environment = deployment.environment ? ` (${deployment.environment})` : "";

      return {
        title: `Deployment ${said}${branch}${environment}${where}`,
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
