import { type EventTypeForSource, getIdPath } from "@alfred/contracts";
import { z } from "zod";

/**
 * One schema per declared GitHub event type (ADR-0097 item 2). The fold, the descriptor and the
 * briefing read a stored body through these, never through path reads.
 *
 * Lenient on purpose: every leaf and every nested object drops to `undefined` when its type is
 * wrong, as a path read does, so one bad field never drops the whole delivery. Only a body that is
 * not an object fails. A stricter schema would stop a verified state from folding (ADR-0062).
 */

function lenient<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

const text = lenient(z.string());

/** The `getIdPath` rule: a non-empty string, or a safe integer as text. A missing key is `undefined`. */
const providerId = z
  .unknown()
  .transform((value) => getIdPath(value) ?? undefined)
  .optional();

/** A provider timestamp. Text that is not a date gives `undefined`, so the store uses receipt time. */
const providerTime = lenient(z.string().pipe(z.coerce.date()));

/** `repository.pushed_at` on a push is Unix seconds, not ISO text. */
const unixSeconds = lenient(
  z
    .number()
    .int()
    .positive()
    .transform((s) => new Date(s * 1000)),
);

const repositorySchema = lenient(
  z.object({ full_name: text, html_url: text, pushed_at: unixSeconds }),
);

/** Who sent the delivery. Not the actor of every kind (ADR-0118): the activity reducer decides. */
const senderSchema = lenient(z.object({ id: providerId, login: text, type: text }));

const pullRequestSchema = lenient(
  z.object({
    id: providerId,
    number: providerId,
    title: text,
    html_url: text,
    merged: lenient(z.boolean()),
    head: lenient(z.object({ sha: text, ref: text })),
    /** The branch that the pull request merges into. The merge push goes to it. */
    base: lenient(z.object({ ref: text })),
    created_at: providerTime,
    updated_at: providerTime,
    closed_at: providerTime,
    merged_at: providerTime,
    /** The sha that the base branch moved to, for each merge method. The merge push has it as `after`. */
    merge_commit_sha: text,
  }),
);

const GITHUB_EVENT_SCHEMAS = {
  pull_request: z.object({
    action: text,
    pull_request: pullRequestSchema,
    repository: repositorySchema,
    sender: senderSchema,
  }),
  check_suite: z.object({
    action: text,
    check_suite: lenient(
      z.object({
        id: providerId,
        conclusion: text,
        status: text,
        head_sha: text,
        head_branch: text,
        updated_at: providerTime,
      }),
    ),
    repository: repositorySchema,
  }),
  /** Only Vercel's dispatch is read (#1167). Vercel writes `client_payload`. */
  repository_dispatch: z.object({
    action: text,
    client_payload: lenient(
      z.object({
        id: text,
        url: text,
        environment: text,
        git: lenient(z.object({ ref: text })),
        project: lenient(z.object({ name: text })),
        // The deletion detail: `isVercelDeploymentDeletion` reads it.
        state: lenient(z.object({ detail: text })),
      }),
    ),
    repository: repositorySchema,
  }),
  push: z.object({
    action: text,
    ref: text,
    /** The head sha before the push. */
    before: text,
    /** The head sha after the push. */
    after: text,
    /** True when the push deleted the ref. */
    deleted: lenient(z.boolean()),
    commits: lenient(z.array(z.unknown())),
    /** `committer.username` is `web-flow` when GitHub made the commit: a merge, an update-branch, or a browser edit. */
    head_commit: lenient(z.object({ committer: lenient(z.object({ username: text })) })),
    compare: text,
    repository: repositorySchema,
    sender: senderSchema,
  }),
  issues: z.object({
    action: text,
    issue: lenient(
      z.object({
        id: providerId,
        number: lenient(z.number()),
        title: text,
        html_url: text,
        created_at: providerTime,
        updated_at: providerTime,
        closed_at: providerTime,
      }),
    ),
    repository: repositorySchema,
    sender: senderSchema,
  }),
  pull_request_review: z.object({
    action: text,
    pull_request: pullRequestSchema,
    review: lenient(
      z.object({ id: providerId, state: text, html_url: text, submitted_at: providerTime }),
    ),
    repository: repositorySchema,
    sender: senderSchema,
  }),
} satisfies { [T in EventTypeForSource<"github">]: z.ZodType };

type GithubEventType = EventTypeForSource<"github">;

type GithubPayloads = {
  [T in GithubEventType]: z.output<(typeof GITHUB_EVENT_SCHEMAS)[T]>;
};

export type GithubPayload<T extends GithubEventType> = GithubPayloads[T];

export type GithubEvent = {
  [T in GithubEventType]: { eventType: T; payload: GithubPayloads[T] };
}[GithubEventType];

function githubEvent<T extends GithubEventType>(
  eventType: T,
  schema: z.ZodType<GithubPayloads[T]>,
  raw: unknown,
): { eventType: T; payload: GithubPayloads[T] } | null {
  const parsed = schema.safeParse(raw);

  return parsed.success ? { eventType, payload: parsed.data } : null;
}

/**
 * A stored GitHub body, typed by its event. `null`: the body is not an object, or the type is not a
 * GitHub type. Only a caller that is generic over its source can pass such a type.
 */
export function parseGithubEvent(eventType: GithubEventType, raw: unknown): GithubEvent | null {
  switch (eventType) {
    case "pull_request":
      return githubEvent(eventType, GITHUB_EVENT_SCHEMAS.pull_request, raw);
    case "check_suite":
      return githubEvent(eventType, GITHUB_EVENT_SCHEMAS.check_suite, raw);
    case "repository_dispatch":
      return githubEvent(eventType, GITHUB_EVENT_SCHEMAS.repository_dispatch, raw);
    case "push":
      return githubEvent(eventType, GITHUB_EVENT_SCHEMAS.push, raw);
    case "issues":
      return githubEvent(eventType, GITHUB_EVENT_SCHEMAS.issues, raw);
    case "pull_request_review":
      return githubEvent(eventType, GITHUB_EVENT_SCHEMAS.pull_request_review, raw);
    default:
      // Unreachable for a literal source. A generic `S` can still land here at runtime with
      // another source's type, so fold nothing.
      return null;
  }
}
