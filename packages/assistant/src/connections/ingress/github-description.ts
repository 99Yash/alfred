import { isEventTypeForSource, type EventTypeForSource } from "@alfred/contracts";
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
    summary: activity.title.replace(/\s+/g, " "),
    body: `${activity.title}\n${fallback.body}`,
  };
}
