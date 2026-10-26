import { type EventTypeForSource, getIdPath, isEventTypeForSource } from "@alfred/contracts";
import { z } from "zod";

/**
 * One schema per declared GitHub event type (ADR-0097 item 2). The fold, the descriptor and the
 * briefing read a stored body through these, never through path reads. The Sentry schema lives with
 * its descriptor in `ingress/sentry.ts` and uses the primitives below.
 *
 * Lenient on purpose: every leaf and every nested object drops to `undefined` when its type is
 * wrong, as a path read does, so one bad field never drops the whole delivery. Only a body that is
 * not an object fails. A stricter schema would stop a verified state from folding (ADR-0062).
 */

export function lenient<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

export const text = lenient(z.string());

/**
 * A field of a shape on the Sentry id path (the root, `data`, and `issue` shapes of
 * `sentryIssueEventSchema` in `ingress/sentry.ts`). Each field there is a `.catch`-wrapped
 * optional or `providerId`. A `satisfies Record<string, LenientField>` clause on each shape
 * enforces that much at `check-types`. Tier 5 means review only: no gate checks the residue.
 *
 * The guard checks only the shape literal that carries the clause, and only the wrapper
 * type. It does not check the work of a catch handler or a transform.
 *
 * Residue that makes the key null (the delivery drops as `no-dedup-key`, a 200, no receipt):
 * a refine or check added after the `.catch`; a `providerId` transform that reports an issue;
 * an object-level refine on a guarded shape; strict object mode (`strictObject`, `.strict()`);
 * `.catchall(...)`; `.extend(...)` with a strict field (the added field sits outside the
 * guarded literal); a hoisted `z.object` passed to `lenient` with no `satisfies` clause.
 *
 * Residue that throws (a 500, no receipt, the provider retries): a catch handler that throws;
 * a transform that throws in any `lenient(...)` field (`.catch` does not catch a thrown
 * error); an async refinement, which makes `safeParse` throw.
 */
export type LenientField = z.ZodCatch<z.ZodOptional<z.ZodType>> | typeof providerId;

/** The `getIdPath` rule: a non-empty string, or a safe integer as text. A missing key is `undefined`. */
export const providerId = z
  .unknown()
  .transform((value) => getIdPath(value) ?? undefined)
  .optional();

/** A provider timestamp. Text that is not a date gives `undefined`, so the store uses receipt time. */
const providerTime = lenient(z.string().pipe(z.coerce.date()));

const repositorySchema = lenient(z.object({ full_name: text, html_url: text }));

const pullRequestSchema = lenient(
  z.object({
    id: providerId,
    number: providerId,
    title: text,
    html_url: text,
    merged: lenient(z.boolean()),
    head: lenient(z.object({ sha: text, ref: text })),
  }),
);

const GITHUB_EVENT_SCHEMAS = {
  pull_request: z.object({
    action: text,
    pull_request: pullRequestSchema,
    repository: repositorySchema,
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
    commits: lenient(z.array(z.unknown())),
    compare: text,
    repository: repositorySchema,
  }),
  issues: z.object({
    action: text,
    issue: lenient(z.object({ number: lenient(z.number()), title: text, html_url: text })),
    repository: repositorySchema,
  }),
  pull_request_review: z.object({
    action: text,
    pull_request: pullRequestSchema,
    review: lenient(z.object({ state: text, html_url: text })),
    repository: repositorySchema,
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

/** A stored GitHub body, typed by its event. `null` for an undeclared type or a non-object body. */
export function parseGithubEvent(eventType: string, raw: unknown): GithubEvent | null {
  if (!isEventTypeForSource("github", eventType)) return null;

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
    default: {
      const _exhaustive: never = eventType;

      return _exhaustive;
    }
  }
}
