import {
  activityPayloadSchema,
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
import type { Document, Observation } from "@alfred/db/schemas";
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
 * - One merge is one row. GitHub sends a `pull_request` "closed" delivery and a `push` to the base
 *   branch for each merge, in either order. The push's `after` is the pull request's
 *   `merge_commit_sha`, so both rows get the family key of that commit on that branch, and a
 *   `merged` head outranks a `pushed` row. Only a
 *   push whose head commit GitHub made (`web-flow`) gets that key. A browser edit and an
 *   update-branch push also have the `web-flow` committer, but no merge shares their commit, so
 *   they stay `pushed` rows.
 * - Every other push is one act: its family key holds the push's own transition and time, so the
 *   same sha pushed twice gives two rows, and a redelivery gives the same key.
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
  /** A merge's own family, for when its commit family already holds another pull request's merge. */
  readonly ownFamilyKey?: string;
  /** Every activity kind's schema shares one sender shape. */
  readonly sender: GithubPayload<"push">["sender"];
}

/**
 * One activity row and the rule that keeps a stronger head of its family. Pass both to
 * `appendObservationFamilyMember(row, { keepHead })`: the rule runs under the family lock. When
 * the result is `kept_head`, append `otherwise` if it is not `null`.
 */
export interface GithubActivityAppend {
  readonly row: ObservationInsertInput;
  readonly keepHead: (head: Observation) => boolean;
  /**
   * The same act in its own family. One push can merge two pull requests (a stacked pull request
   * that the base merge also contains), so both merges have the same commit. The first one takes
   * the commit family. The second one keeps its row here.
   */
  readonly otherwise: ObservationInsertInput | null;
}

/** The activity row for one delivery, or `null` when the delivery is not an activity. */
export function reduceGithubActivity(
  doc: GithubActivityDocument,
  self: GithubSelf,
): GithubActivityAppend | null {
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
      facts = pushFacts(event.payload, doc.sourceId);
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

  const row: ObservationInsertInput = {
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

  const { verb, ownFamilyKey } = facts;

  // A merge outranks the push that GitHub made for it, whichever delivery came first. A merge of
  // another pull request at the head sends this merge to its own family.
  const keepHead = (head: Observation): boolean =>
    isMergedHead(head) && (verb === "pushed" || head.objectIdentity?.value !== object.value);

  return {
    row,
    keepHead,
    otherwise:
      ownFamilyKey && ownFamilyKey !== facts.familyKey ? { ...row, familyKey: ownFamilyKey } : null,
  };
}

function isMergedHead(head: Observation): boolean {
  const payload = activityPayloadSchema.safeParse(head.payload);

  return payload.success && payload.data.verb === "merged";
}

/**
 * The family key of a commit that lands on a branch. The merged row and the push that GitHub made
 * for the merge share it. The branch is part of the key, so the same commit pushed to another
 * branch later is a separate act.
 */
function landedCommitKey(args: {
  repoFullName: string | undefined;
  branch: string | undefined;
  sha: string;
}): string | null {
  const { repoFullName, branch, sha } = args;

  if (!repoFullName || !branch) return null;
  const target = canonicalizeGithubTargetId({ repoFullName, branch });

  return target ? `github:commit:${target}@${sha}` : null;
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
        ? {
            ...base,
            verb: "merged",
            occurredAt: pr.merged_at,
            familyKey:
              (pr.merge_commit_sha
                ? landedCommitKey({
                    repoFullName: payload.repository?.full_name,
                    branch: pr.base?.ref,
                    sha: pr.merge_commit_sha,
                  })
                : null) ?? `${object}:merged`,
            ownFamilyKey: `${object}:merged`,
          }
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

/**
 * A push of new commits to a branch. A delete and a tag give nothing. `receiptId` names the push
 * only when the body has no push time.
 */
function pushFacts(payload: GithubPayload<"push">, receiptId: string): ActivityFacts | null {
  const { ref, before, after, repository } = payload;

  if (payload.deleted === true || !after || !ref?.startsWith(BRANCH_REF_PREFIX)) return null;

  if ((payload.commits?.length ?? 0) === 0) return null;
  const repoFullName = repository?.full_name;

  if (!repoFullName) return null;
  const branch = ref.slice(BRANCH_REF_PREFIX.length);
  const target = canonicalizeGithubTargetId({ repoFullName, branch });

  if (!target) return null;
  const object = `github:ci_target:${target}`;
  const pushedAt = repository.pushed_at;

  const occurrence = pushedAt
    ? `${before ?? "unknown"}..${after}@${pushedAt.getTime()}`
    : `receipt:${receiptId}`;

  const familyKey =
    (payload.head_commit?.committer?.username === GITHUB_WEB_FLOW_LOGIN
      ? landedCommitKey({ repoFullName, branch, sha: after })
      : null) ?? `${object}:push:${occurrence}`;

  return { verb: "pushed", object, occurredAt: pushedAt, familyKey, sender: payload.sender };
}
