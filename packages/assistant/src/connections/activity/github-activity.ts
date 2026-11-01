import {
  canonicalizeGithubTargetId,
  assertNever,
  canonicalizeIdentityValue,
  isEventTypeForSource,
  type ActivityPayload,
  type ActivityVerb,
  type IdentityRef,
  type ObservationInsertInput,
  type ObservationSubject,
} from "@alfred/contracts";
import { sha256Canonical } from "@alfred/db/hash";
import type { Document } from "@alfred/db/schemas";
import { parseGithubEvent, type GithubPayload } from "../ingress/receipt-schemas";

/**
 * The GitHub activity reducer (ADR-0118 decision 1). Pure. One stored delivery gives one activity
 * row or none. Only an action by a person on a thing is a row, and only for a verb in the
 * `github` list of `OBSERVATION_REDUCERS`. `workflow_job`, `check_suite`, labels, edits and syncs
 * are state or noise, so they give nothing, even when the user sent them.
 *
 * - The actor is the delivery's `sender`, but only for these kinds, where the sender did the act.
 * - `occurredAt` is the provider's time from the body. `documents.authored_at` is the arrival
 *   time, so it is only the fallback.
 * - One merge is one row: the `push` that GitHub makes for a merge has the `web-flow` committer and
 *   gives nothing. An update-branch push has the same committer and also gives nothing.
 * - The object is the `integration_objects` key (`github:<kind>:<externalId>`, ADR-0118 decision 1),
 *   so a reader joins a row to its object state. A pull request is its numeric GitHub id, as in the
 *   object-state fold. The keys are not built with `integrationObjectKey`: that builder takes only
 *   entity-graph segments, and `ci_target` is object state, not an entity. The referent key
 *   (`github:pull_request:owner/repo#913`, ADR-0092) is a different key for the same pull request.
 */

/** Bump when a rule changes, so a replay appends superseding rows (ADR-0067 D4). */
const GITHUB_ACTIVITY_REDUCER_VERSION = 1;

/** The committer login that GitHub uses for a commit it makes itself. */
const GITHUB_WEB_FLOW_LOGIN = "web-flow";

const BRANCH_REF_PREFIX = "refs/heads/";

/** The `sender.type` of a GitHub App account. */
const GITHUB_BOT_SENDER_TYPE = "Bot";

/** The fields of one stored GitHub delivery that the reducer reads. */
export type GithubActivityDocument = Pick<
  Document,
  "id" | "userId" | "sourceId" | "accountId" | "authoredAt" | "raw"
> & {
  /** `documents.metadata.kind`: `<event>` or `<event>.<action>`. */
  readonly kind: string;
};

/** How the reducer knows the user. Either match makes the actor the user. */
export interface GithubSelf {
  /** GitHub account ids of the user's credentials. The document's `account_id` also counts. */
  readonly userIds: ReadonlySet<string>;
  /** Canonical logins: credential labels and the `github_username` fact. */
  readonly logins: ReadonlySet<string>;
}

type GithubVerb = ActivityVerb<"github">;

interface ActivityFacts {
  readonly verb: GithubVerb;
  readonly object: string;
  readonly occurredAt: Date | undefined;
  readonly familyKey: string;
  /** Every activity kind's schema shares one sender shape. */
  readonly sender: GithubPayload<"push">["sender"];
}

/** The activity row for one delivery, or `null` when the delivery is not an activity. */
export function reduceGithubActivity(
  doc: GithubActivityDocument,
  self: GithubSelf,
): ObservationInsertInput | null {
  const [eventName = ""] = doc.kind.split(".");

  if (!doc.accountId || !isEventTypeForSource("github", eventName)) return null;
  const event = parseGithubEvent(eventName, doc.raw);

  if (!event) return null;
  let facts: ActivityFacts | null;

  switch (event.eventType) {
    case "pull_request":
      facts = pullRequestFacts(event.payload);
      break;
    case "issues":
      facts = issueFacts(event.payload);
      break;
    case "pull_request_review":
      facts = reviewFacts(event.payload);
      break;
    case "push":
      facts = pushFacts(event.payload);
      break;
    case "check_suite":
    case "repository_dispatch":
      facts = null;
      break;
    // `parseGithubEvent` parsed the kind, so this is unreachable. A new GitHub event kind does
    // not compile until it is listed here.
    default:
      return assertNever(event, "GitHub activity event");
  }

  const actorId = facts?.sender?.id;

  // An activity row is an action by a person (ADR-0118 decision 1). A GitHub App account, such as
  // `dependabot[bot]`, has `type` "Bot". Its pull requests reach the user through object state.
  if (!facts || !actorId || facts.sender?.type === GITHUB_BOT_SENDER_TYPE) return null;
  const occurredAt = facts.occurredAt ?? doc.authoredAt;

  if (!occurredAt) return null;

  const actorLogin = facts.sender?.login
    ? canonicalizeIdentityValue("github_login", facts.sender.login)
    : null;

  // `doc.accountId` is the GitHub user id of the credential that received the delivery, so a match
  // is the user. The credential ids and logins also count, for a document from an older credential.
  const subject: ObservationSubject =
    actorId === doc.accountId ||
    self.userIds.has(actorId) ||
    (actorLogin !== null && self.logins.has(actorLogin))
      ? { kind: "user" }
      : { kind: "github_user_id", value: actorId };

  const object: IdentityRef = {
    kind: "integration_object_key",
    value: canonicalizeIdentityValue("integration_object_key", facts.object),
  };

  const payload: ActivityPayload = {
    source: { kind: "integration", slug: "github" },
    verb: facts.verb,
    documentId: doc.id,
    receiptId: doc.sourceId,
    accountId: doc.accountId,
    actorLogin,
  };

  return {
    userId: doc.userId,
    source: "github",
    kind: "activity",
    occurredAt,
    familyKey: facts.familyKey,
    evidenceHash: sha256Canonical({
      verb: facts.verb,
      subject,
      object,
      occurredAt: occurredAt.toISOString(),
    }),
    subjectIdentity: subject,
    objectIdentity: object,
    payload,
    reducerVersion: GITHUB_ACTIVITY_REDUCER_VERSION,
  };
}

/** A family key part for an act that can repeat on one thing, such as a close and a reopen. */
function instant(at: Date | undefined): string {
  return at ? String(at.getTime()) : "unknown";
}

function pullRequestFacts(payload: GithubPayload<"pull_request">): ActivityFacts | null {
  const pr = payload.pull_request;

  if (!pr?.id) return null;
  const object = `github:pull_request:${pr.id}`;
  const base = { object, sender: payload.sender };

  switch (payload.action) {
    case "opened":
      return { ...base, verb: "opened", occurredAt: pr.created_at, familyKey: `${object}:opened` };
    case "closed":
      return pr.merged === true
        ? { ...base, verb: "merged", occurredAt: pr.merged_at, familyKey: `${object}:merged` }
        : {
            ...base,
            verb: "closed",
            occurredAt: pr.closed_at,
            familyKey: `${object}:closed:${instant(pr.closed_at)}`,
          };
    case "reopened":
      return {
        ...base,
        verb: "reopened",
        occurredAt: pr.updated_at,
        familyKey: `${object}:reopened:${instant(pr.updated_at)}`,
      };
    case undefined:
    default:
      return null;
  }
}

function issueFacts(payload: GithubPayload<"issues">): ActivityFacts | null {
  const issue = payload.issue;

  if (!issue?.id) return null;
  const object = `github:issue:${issue.id}`;
  const base = { object, sender: payload.sender };

  switch (payload.action) {
    case "opened":
      return {
        ...base,
        verb: "opened",
        occurredAt: issue.created_at,
        familyKey: `${object}:opened`,
      };
    case "closed":
      return {
        ...base,
        verb: "closed",
        occurredAt: issue.closed_at,
        familyKey: `${object}:closed:${instant(issue.closed_at)}`,
      };
    case "reopened":
      return {
        ...base,
        verb: "reopened",
        occurredAt: issue.updated_at,
        familyKey: `${object}:reopened:${instant(issue.updated_at)}`,
      };
    case undefined:
    default:
      return null;
  }
}

function reviewFacts(payload: GithubPayload<"pull_request_review">): ActivityFacts | null {
  const prId = payload.pull_request?.id;
  const review = payload.review;

  if (payload.action !== "submitted" || !prId || !review?.id) return null;

  return {
    verb: "reviewed",
    object: `github:pull_request:${prId}`,
    occurredAt: review.submitted_at,
    familyKey: `github:review:${review.id}`,
    sender: payload.sender,
  };
}

/** A push of new commits to a branch. A delete, a tag, and a GitHub-made commit give nothing. */
function pushFacts(payload: GithubPayload<"push">): ActivityFacts | null {
  const { ref, after, repository } = payload;

  if (payload.deleted === true || !after || !ref?.startsWith(BRANCH_REF_PREFIX)) return null;

  if ((payload.commits?.length ?? 0) === 0) return null;

  if (payload.head_commit?.committer?.username === GITHUB_WEB_FLOW_LOGIN) return null;
  const repoFullName = repository?.full_name;

  if (!repoFullName) return null;

  const target = canonicalizeGithubTargetId({
    repoFullName,
    branch: ref.slice(BRANCH_REF_PREFIX.length),
  });

  if (!target) return null;
  const object = `github:ci_target:${target}`;

  return {
    verb: "pushed",
    object,
    occurredAt: repository.pushed_at,
    familyKey: `${object}:${after}`,
    sender: payload.sender,
  };
}
