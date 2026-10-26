/**
 * Object-state registry (ADR-0062): each provider's object kinds, key kinds, and
 * how a native state maps to a `StateCategory`. `satisfies` forces a complete
 * definition per provider, which Postgres cannot check.
 */

import { z } from "zod";
import { emailDomain, isDomainOrSubdomain, normalizeDomain } from "./domain";
import { enumGuard, parseEmailAddress } from "./guards";
import { canonicalizeIdentityValue } from "./user-model";

export const OBJECT_STATE_CATEGORIES = ["active", "resolved", "failed", "abandoned"] as const;

export type StateCategory = (typeof OBJECT_STATE_CATEGORIES)[number];

/**
 * Categories that may close an open ask. `failed` is out: it usually opens a CI loop.
 * Each kind narrows this, so decide closure with {@link closesOpenAsk}, not this tuple.
 */
export const LOOP_CLOSING_STATE_CATEGORIES = ["resolved", "abandoned"] as const;

export type LoopClosingStateCategory = (typeof LOOP_CLOSING_STATE_CATEGORIES)[number];

/**
 * How a producer knows an object state (#1094). Text evidence is not a member:
 * it may trigger a pull, never assert. No store branch reads this.
 */
export const OBJECT_STATE_CLOSURE_SOURCES = ["verified_push", "verified_pull"] as const;

export type ClosureSource = (typeof OBJECT_STATE_CLOSURE_SOURCES)[number];

/**
 * The reading a kind needs before it may assert a closure (ADR-0103).
 * - `stored_projection`: the stored row is enough.
 * - `live_confirmation`: the row only nominates. The store orders by observation time,
 *   so a late resolve after an unresolve would falsely read `resolved` (`sentry.issue`).
 *   A pull-only row can also be older than the failure an email reports
 *   (`railway.deployment_target`).
 * A sync reader with no IO can only pass `stored_projection`.
 */
export const CLOSURE_PROOFS = ["stored_projection", "live_confirmation"] as const;

export type ClosureProof = (typeof CLOSURE_PROOFS)[number];

/** A live read satisfies every kind. */
const PROOF_STRENGTH = {
  stored_projection: 0,
  live_confirmation: 1,
} satisfies Record<ClosureProof, number>;

/**
 * Lifecycle policy per kind, because it differs per kind, not per provider (#1093).
 * - `closesAskOn`: categories that close an open ask.
 * - `closesAskFrom`: the weakest reading that may assert them. No default, on purpose.
 * - `absorbing`: categories no later delivery may leave (a merged PR).
 *   Kinds that close by succession (CI runs, deployments) declare `[]`.
 */
export interface ObjectKindDef {
  readonly closesAskOn: readonly LoopClosingStateCategory[];
  readonly closesAskFrom: ClosureProof;
  readonly absorbing: readonly StateCategory[];
  /**
   * True when one identity names one piece of work, so a todo may carry it as a source ref: a
   * live todo merges on it and a resolved todo suppresses it (ADR-0092 A1). A target (a branch, a
   * service) fails again and again, and a Sentry issue can regress, so one dismissed todo would hide
   * the next failure. Each declares `false`. No default, on purpose.
   */
  readonly todoIdentity: boolean;
  /** Links evidence to a row of this kind with no grammar (ADR-0109 rule 2). Absent: it cannot. */
  readonly identity?: ObjectIdentityDecl;
}

/** One attribute of `integration_objects.attributes` that names the object. */
export const identityAttributeSchema = z
  .strictObject({
    attribute: z.string().min(1),
    /** A prefix the provider removes in its links (Vercel `dpl_`). The bare value then also counts. */
    droppedPrefix: z.string().min(1).optional(),
    /**
     * The path segment or query parameter that precedes the value in a provider link: `service` in
     * `/service/<id>`, `environmentId` in `?environmentId=<id>`. It tells which kind the value
     * names. Absent: the value may sit anywhere in the link, so the link only nominates the object.
     */
    linkLabel: z.string().min(1).optional(),
  })
  .readonly();

export type IdentityAttribute = z.infer<typeof identityAttributeSchema>;

/**
 * The identity a kind declares (ADR-0109 rule 2). Two or more strong values, or one value the
 * provider guarantees unique. The tuple schema also rejects repeated attribute names.
 * All values must occur in one provider link. A link proves the object only when each value has a
 * `linkLabel` (see {@link identityProvesLink}).
 */
export const objectIdentityDeclSchema = z.union([
  z.strictObject({ uniqueKey: identityAttributeSchema }).readonly(),
  z
    .strictObject({
      tuple: z
        .tuple([identityAttributeSchema, identityAttributeSchema], identityAttributeSchema)
        .refine(
          (attributes) =>
            new Set(attributes.map(({ attribute }) => attribute)).size === attributes.length,
          { message: "identity tuple attributes must be distinct" },
        )
        .readonly(),
    })
    .readonly(),
]);

export type ObjectIdentityDecl = z.infer<typeof objectIdentityDeclSchema>;

export function identityAttributes(decl: ObjectIdentityDecl): readonly IdentityAttribute[] {
  return "uniqueKey" in decl ? [decl.uniqueKey] : decl.tuple;
}

/**
 * True when a link that holds this identity proves the object, so the link may close an ask. Each
 * value needs a `linkLabel`. Without one, a link with two objects of the kind cannot tell which
 * value belongs to which, and a bare number can be a billing reference.
 */
export function identityProvesLink(decl: ObjectIdentityDecl): boolean {
  return identityAttributes(decl).every((attribute) => attribute.linkLabel !== undefined);
}

export interface IntegrationObjectDef {
  /**
   * Domains that send this provider's notification mail and serve its links. A mail from one may
   * be `about` an object of the provider, and only a link on one can name an identity. A subdomain
   * also counts.
   */
  readonly domains: readonly string[];
  readonly kinds: Readonly<Record<string, ObjectKindDef>>;
  /** Minimum prefix length per key kind that allows abbreviated lookup (a 7-hex sha). Absent means exact only. */
  readonly prefixableKeys: Readonly<Record<string, number>>;
  /** Map a native state token for one kind. `null` for an unknown token, which never closes. */
  normalize(kind: string, nativeState: string): StateCategory | null;
}

export const OBJECT_STATE_PROVIDERS = ["github", "sentry", "railway", "vercel", "mcp"] as const;

export type ObjectStateProvider = (typeof OBJECT_STATE_PROVIDERS)[number];

const GITHUB_PULL_REQUEST_URL_RE =
  /^https?:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/** Canonical `pull_request_url` key. Repo names are case-insensitive, so it lowercases them. */
export function canonicalizeGithubPullRequestUrl(
  input: { url: string } | { repoFullName: string; number: number },
): string | null {
  let repoFullName: string;
  let number: number;

  if ("url" in input) {
    const match = input.url.trim().match(GITHUB_PULL_REQUEST_URL_RE);

    if (!match?.[1] || !match[2]) return null;
    repoFullName = match[1];
    number = Number(match[2]);
  } else {
    repoFullName = input.repoFullName;
    number = input.number;
  }

  if (!Number.isSafeInteger(number) || number < 1) return null;

  const repoParts = repoFullName.trim().split("/");

  if (repoParts.length !== 2 || repoParts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    return null;
  }

  const repo = canonicalizeIdentityValue("github_repository_full_name", repoFullName);

  return `https://github.com/${repo}/pull/${number}`;
}

/** Inverse of {@link canonicalizeGithubPullRequestUrl}. Parses the canonical form, never the raw input. */
export function parseGithubPullRequestUrl(url: string): {
  repoFullName: string;
  number: number;
} | null {
  const canonical = canonicalizeGithubPullRequestUrl({ url });

  if (!canonical) return null;

  const match = canonical.match(GITHUB_PULL_REQUEST_URL_RE);

  if (!match?.[1] || !match[2]) return null;

  const number = Number(match[2]);

  if (!Number.isSafeInteger(number) || number < 1) return null;

  return { repoFullName: match[1], number };
}

/**
 * CI target id `owner/repo#branch` (#1093). The repo folds to lower case; the branch
 * keeps its case. A branch that holds `#` reads back ambiguously. Known, not solved.
 */
export function canonicalizeGithubTargetId(input: {
  repoFullName: string;
  branch: string;
}): string | null {
  const repoParts = input.repoFullName.trim().split("/");

  if (repoParts.length !== 2 || repoParts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    return null;
  }

  const branch = input.branch.trim();

  if (branch.length < 1 || branch.length > 255) return null;

  const repo = canonicalizeIdentityValue("github_repository_full_name", input.repoFullName);

  return `${repo}#${branch}`;
}

/**
 * Railway target id `projectId/serviceId/environmentId` (#1094). Railway mails failures
 * but not recoveries, so only a pull of this target can close. Opaque ids: no case fold.
 */
export function canonicalizeRailwayTargetId(input: {
  projectId: string;
  serviceId: string;
  environmentId: string;
}): string | null {
  const projectId = input.projectId.trim();
  const serviceId = input.serviceId.trim();
  const environmentId = input.environmentId.trim();

  if (!projectId || !serviceId || !environmentId) return null;

  if (projectId.includes("/") || serviceId.includes("/") || environmentId.includes("/")) {
    return null;
  }

  return `${projectId}/${serviceId}/${environmentId}`;
}

const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * The branch a ref names: `main` and `refs/heads/main` both give `main`, so one target
 * does not split in two. Other `refs/` (tags, pull refs) give `null`. Idempotent.
 */
export function parseGitBranchRef(ref: string): string | null {
  const trimmed = ref.trim();

  const branch = trimmed.startsWith(BRANCH_REF_PREFIX)
    ? trimmed.slice(BRANCH_REF_PREFIX.length)
    : trimmed;

  if (!branch || branch.startsWith("refs/")) return null;

  return branch;
}

/**
 * Vercel target id `owner/repo#branch#env` (#1167). `env` keeps preview apart from production.
 * Pass the deployment's `client_payload.git.ref`, not the dispatch's top-level `branch`:
 * GitHub always dispatches on the default branch, so that field reads `main`.
 * A separate function, so a vercel caller cannot omit `env` and mint a `ci_target` id.
 */
export function canonicalizeVercelTargetId(input: {
  repoFullName: string;
  branch: string;
  environment: string;
}): string | null {
  const branch = parseGitBranchRef(input.branch);

  if (!branch) return null;

  // A `#` in a tail segment would make the id ambiguous to split.
  if (branch.includes("#")) return null;

  const base = canonicalizeGithubTargetId({
    repoFullName: input.repoFullName,
    branch,
  });

  if (!base) return null;

  const environment = input.environment.trim();

  if (!environment || environment.length > 64 || environment.includes("#")) return null;

  return `${base}#${environment}`;
}

const DEPLOYMENT_STATUSES = ["success", "failure", "pending"] as const;

/** A deployment's verdict, from a Vercel dispatch or a verified Railway/Vercel pull. */
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** Narrows a stored `nativeState` value to a declared deployment status. */
export const isDeploymentStatus = enumGuard(DEPLOYMENT_STATUSES);

const DEPLOYMENT_STATE_CATEGORIES = {
  success: "resolved",
  failure: "failed",
  pending: "active",
} as const satisfies Record<DeploymentStatus, StateCategory>;

/** Railway and Vercel `normalize`: both deployment kinds, one token table. */
function normalizeDeploymentStatus(kind: string, nativeState: string): StateCategory | null {
  if (kind !== "deployment_attempt" && kind !== "deployment_target") return null;

  return isDeploymentStatus(nativeState) ? DEPLOYMENT_STATE_CATEGORIES[nativeState] : null;
}

/**
 * Vercel dispatch action to outcome. Any other action, from any dispatcher, means nothing.
 * Vercel's list is `vercel/repository-dispatch` `types.ts`, plus `ready` from its GitHub docs.
 * `canceled`, `ignored`, and `skipped` stay out on purpose: each says the build did not run to an
 * end, so none is a verdict on the target. An `error` that is not a deletion stays `failure`:
 * Vercel types `error` with one optional detail, so without it the deployment itself errored.
 */
const VERCEL_DISPATCH_ACTION_OUTCOMES: ReadonlyMap<string, DeploymentStatus> = new Map([
  ["vercel.deployment.error", "failure"],
  ["vercel.deployment.failed", "failure"],
  ["vercel.deployment.success", "success"],
  ["vercel.deployment.ready", "success"],
  ["vercel.deployment.promoted", "success"],
  ["vercel.deployment.pending", "pending"],
]);

/**
 * A retention deletion. Vercel sends it as `vercel.deployment.error` with
 * `client_payload.state.detail: "deployment_deleted"`, so the action alone cannot tell it from a
 * failed build. Measured 2026-10-17: every prod `error` receipt (298) was a deletion.
 */
export function isVercelDeploymentDeletion(
  action: string | null | undefined,
  detail: string | undefined,
): boolean {
  return action === "vercel.deployment.error" && detail === "deployment_deleted";
}

/**
 * Outcome of one dispatch: its `action` and its `client_payload.state.detail`. `null` for an unknown
 * action and for a deletion: neither is evidence about the target's health. It must never read as a
 * success.
 */
export function vercelDeploymentOutcome(
  action: string | null | undefined,
  detail: string | undefined,
): DeploymentStatus | null {
  if (!action || isVercelDeploymentDeletion(action, detail)) return null;

  return VERCEL_DISPATCH_ACTION_OUTCOMES.get(action) ?? null;
}

export const isObjectStateProvider = enumGuard(OBJECT_STATE_PROVIDERS);

/** Excludes `mcp`, so an MCP result cannot override a provider's own verdict. */
export function isBuiltInObjectStateProvider(
  provider: string,
): provider is Exclude<ObjectStateProvider, "mcp"> {
  return provider !== "mcp" && isObjectStateProvider(provider);
}

/**
 * Sentry issue native states. Two producers write them: the webhook reducer and the
 * live read. The REST API says `ignored` where this says `archived`, so the live read translates.
 */
export const SENTRY_ISSUE_NATIVE_STATES = ["unresolved", "resolved", "archived"] as const;

export type SentryIssueNativeState = (typeof SENTRY_ISSUE_NATIVE_STATES)[number];

/**
 * The registry. Reducers collapse provider payloads to these native tokens:
 * a PR to `open`/`merged`/`closed`, CI and deployments to `success`/`failure`/`pending`.
 */
export const INTEGRATION_OBJECT_DEFS = {
  github: {
    // Gates the GitHub `about` keys (object-state adapter) and the soft-edge count. GitHub
    // declares no identity, so identity containment never reads it (ADR-0109).
    domains: ["github.com"],
    kinds: {
      // Merged absorbs: it can never reopen. Closed-unmerged does not, so a real reopen lands.
      pull_request: {
        closesAskOn: LOOP_CLOSING_STATE_CATEGORIES,
        closesAskFrom: "stored_projection",
        absorbing: ["resolved"],
        todoIdentity: true,
      },
      // An attempt never closes an ask. Only its target does.
      ci_attempt: {
        closesAskOn: [],
        closesAskFrom: "stored_projection",
        absorbing: [],
        todoIdentity: true,
      },
      // State is the latest attempt's outcome. A later failure reopens.
      ci_target: {
        closesAskOn: ["resolved"],
        // A check-suite delivery carries `updated_at`, so rows order by provider time.
        closesAskFrom: "stored_projection",
        absorbing: [],
        todoIdentity: false,
      },
    },
    prefixableKeys: { head_sha: 7 },
    normalize(kind, nativeState) {
      if (kind === "pull_request") {
        switch (nativeState) {
          case "merged":
            return "resolved";
          case "closed":
            return "abandoned";
          case "open":
            return "active";
          default:
            return null;
        }
      }

      // Explicit kinds, so a new kind does not inherit this mapping by accident.
      if (kind === "ci_attempt" || kind === "ci_target") {
        switch (nativeState) {
          case "success":
            return "resolved";
          case "failure":
            return "failed";
          case "pending":
            return "active";
          default:
            return null;
        }
      }

      return null;
    },
  },
  sentry: {
    domains: ["sentry.io"],
    kinds: {
      // Every Sentry transition can reverse, so nothing absorbs. Sentry sends no
      // transition version, so only a live read may close (see `ClosureProof`).
      // `abandoned` stays out: archiving is a triage decision, not a fix.
      issue: {
        closesAskOn: ["resolved"],
        closesAskFrom: "live_confirmation",
        absorbing: [],
        // A regression reopens the issue. It is new work, so a dismissed todo must not hide it.
        todoIdentity: false,
        // Every issue link holds `/issues/<issue_id>/`.
        identity: { uniqueKey: { attribute: "issue_id", linkLabel: "issues" } },
      },
    },
    prefixableKeys: {},
    normalize(_kind, nativeState) {
      switch (nativeState) {
        case "resolved":
          return "resolved";
        case "unresolved":
          return "active";
        case "archived":
          return "abandoned";
        default:
          return null;
      }
    },
  },
  railway: {
    // Failure mails come from `notify.railway.app` and link to `railway.com`.
    domains: ["railway.app", "railway.com"],
    kinds: {
      // Like `ci_attempt`: an attempt never closes an ask.
      deployment_attempt: {
        closesAskOn: [],
        closesAskFrom: "stored_projection",
        absorbing: [],
        todoIdentity: true,
      },
      // The build-failure mail names this target (ADR-0062 amendment 2026-10-20).
      deployment_target: {
        closesAskOn: ["resolved"],
        // Only a pull writes this row, so a stored `success` can be older than the
        // failure the mail reports. A live read must confirm the recovery.
        closesAskFrom: "live_confirmation",
        absorbing: [],
        todoIdentity: false,
        // One project has many services in one environment, so only all three are unique. The
        // build-log link is `/project/<p>/service/<s>?id=<d>&environmentId=<e>`.
        identity: {
          tuple: [
            { attribute: "project_id", linkLabel: "project" },
            { attribute: "service_id", linkLabel: "service" },
            { attribute: "environment_id", linkLabel: "environmentId" },
          ],
        },
      },
    },
    prefixableKeys: {},
    normalize: normalizeDeploymentStatus,
  },
  /**
   * Vercel deployments, relayed as GitHub `repository_dispatch` (#1167). GitHub is
   * only the transport. The payload is Vercel's state. Kind names reuse Railway's.
   */
  vercel: {
    domains: ["vercel.com"],
    kinds: {
      // The fallback when a dispatch has no branch or environment. Never closes an ask.
      deployment_attempt: {
        closesAskOn: [],
        closesAskFrom: "stored_projection",
        absorbing: [],
        todoIdentity: true,
        // The failure mail links `vercel.com/<team>/<project>/<id>` with the `dpl_` removed. No
        // segment labels the id, so the link only nominates. An attempt never closes anyway.
        identity: { uniqueKey: { attribute: "deployment_id", droppedPrefix: "dpl_" } },
      },
      // Empty `closesAskOn`: the failure mail names an attempt, and an attempt never
      // closes. Its tuple (repo, branch, environment) is weak, so it cannot link by
      // containment (ADR-0109). Restore `["resolved"]` when evidence can name it (#1357).
      deployment_target: {
        closesAskOn: [],
        // The dispatch carries Vercel's own state, so nothing reorders into a false close.
        closesAskFrom: "stored_projection",
        absorbing: [],
        todoIdentity: false,
      },
    },
    prefixableKeys: {},
    normalize: normalizeDeploymentStatus,
  },
  /**
   * Owner-reviewed MCP connections (#1196). One generic kind: a new MCP service adds
   * a `mcp_health_mapping` row, not code. The mapping emits canonical tokens.
   */
  mcp: {
    // MCP identities come only from an owner-approved live read, never from mail.
    domains: [],
    kinds: {
      connection_health: {
        closesAskOn: LOOP_CLOSING_STATE_CATEGORIES,
        // Every fold is a live authenticated read, so the row is current.
        closesAskFrom: "stored_projection",
        absorbing: [],
        todoIdentity: false,
      },
    },
    prefixableKeys: {},
    normalize(kind, nativeState) {
      if (kind !== "connection_health") return null;

      switch (nativeState) {
        case "active":
        case "resolved":
        case "failed":
        case "abandoned":
          return nativeState;
        default:
          return null;
      }
    },
  },
} as const satisfies Record<ObjectStateProvider, IntegrationObjectDef>;

export function getObjectDef(provider: ObjectStateProvider): IntegrationObjectDef {
  return INTEGRATION_OBJECT_DEFS[provider];
}

/**
 * The policy for a kind, or `null` if undeclared. `kind` is open text, so an old row
 * or a prototype key (`__proto__`) must read as undeclared.
 */
export function getObjectKindDef(
  provider: ObjectStateProvider,
  kind: string,
): ObjectKindDef | null {
  const kinds: Readonly<Record<string, ObjectKindDef>> = getObjectDef(provider).kinds;

  if (!Object.prototype.hasOwnProperty.call(kinds, kind)) return null;

  return kinds[kind] ?? null;
}

/**
 * The closure this state would assert, and the proof needed first. For nominators only:
 * never put it in user or model text. Assert with {@link closesOpenAsk} (ADR-0103).
 */
export function closureCandidate(
  provider: ObjectStateProvider,
  kind: string,
  category: StateCategory,
): { closesAskAs: LoopClosingStateCategory; proof: ClosureProof } | null {
  const def = getObjectKindDef(provider, kind);

  if (!def) return null;

  for (const closing of def.closesAskOn) {
    if (closing === category) return { closesAskAs: closing, proof: def.closesAskFrom };
  }

  return null;
}

/**
 * The closing category, or `null` if this state does not close or `proof` is too weak.
 * Returns the category, not a boolean: a boolean's `else` would wrongly narrow to
 * `"active" | "failed"`.
 */
export function closesOpenAsk(
  provider: ObjectStateProvider,
  kind: string,
  category: StateCategory,
  proof: ClosureProof,
): LoopClosingStateCategory | null {
  const candidate = closureCandidate(provider, kind, category);

  if (!candidate) return null;

  if (PROOF_STRENGTH[proof] < PROOF_STRENGTH[candidate.proof]) return null;

  return candidate.closesAskAs;
}

/** True if no later delivery may move the object out of this state. */
export function isAbsorbingState(
  provider: ObjectStateProvider,
  kind: string,
  category: string,
): boolean {
  const def = getObjectKindDef(provider, kind);

  if (!def) return false;

  return def.absorbing.some((c) => c === category);
}

/** Canonical PR URLs that a text names, deduplicated. Reads full URLs and `owner/repo#123`. */
export function collectGithubPullRequestUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  const add = (repoFullName: string | undefined, rawNumber: string | undefined) => {
    if (!repoFullName) return;
    const url = canonicalizeGithubPullRequestUrl({ repoFullName, number: Number(rawNumber) });

    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  for (const match of text.matchAll(GITHUB_PULL_REQUEST_MENTION_RE)) {
    add(match[1], match[2]);
  }

  for (const match of text.matchAll(GITHUB_PULL_REQUEST_SHORTHAND_RE)) {
    add(match[1], match[2]);
  }

  return urls;
}

const GITHUB_PULL_REQUEST_MENTION_RE =
  /\bhttps?:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)\b/gi;

const GITHUB_PULL_REQUEST_SHORTHAND_RE = /\b([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)\b/g;

/** ADR-0109 rule 2: a strong identity value has at least this many characters. */
const STRONG_IDENTITY_MIN_LENGTH = 8;

/**
 * ADR-0109 rule 2. Strong: {@link STRONG_IDENTITY_MIN_LENGTH} characters or more, with at least
 * one digit. A UUID, a numeric id and a hex sha are strong; `main` and `production` are weak. A
 * weak value links nothing from mail.
 */
export function isStrongIdentityValue(value: string): boolean {
  return value.length >= STRONG_IDENTITY_MIN_LENGTH && /\d/.test(value);
}

/**
 * The text forms of one stored identity value: the value, and the value without a declared dropped
 * prefix. `null` if a form is weak, because a weak value must link nothing.
 */
export function identityValueForms(
  attribute: IdentityAttribute,
  value: string,
): readonly string[] | null {
  const prefix = attribute.droppedPrefix;

  if (prefix && value.startsWith(prefix)) {
    const bare = value.slice(prefix.length);

    return isStrongIdentityValue(bare) ? [value, bare] : null;
  }

  return isStrongIdentityValue(value) ? [value] : null;
}

/** True when `domain` is one of the provider's {@link IntegrationObjectDef.domains}. */
function isProviderDomain(provider: ObjectStateProvider, domain: string): boolean {
  return getObjectDef(provider).domains.some((base) => isDomainOrSubdomain(domain, base));
}

/** True when a mail from `from` may be `about` an object of this provider. */
export function isNotificationSender(
  provider: ObjectStateProvider,
  from: string | null | undefined,
): boolean {
  const domain = emailDomain(parseEmailAddress(from));

  return domain !== null && isProviderDomain(provider, domain);
}

/**
 * One value of a provider link and the segment or query parameter before it. `label` is `null`
 * for the first path segment.
 */
export interface ProviderLinkValue {
  readonly label: string | null;
  readonly value: string;
}

/** One link in a text on a provider domain, reduced to its id-like values (ADR-0109 rule 2). */
export interface ProviderLink {
  readonly provider: ObjectStateProvider;
  readonly values: readonly ProviderLinkValue[];
}

/** A link up to white space, a quote, or a bracket. Trailing sentence punctuation is cut after. */
const LINK_RE = /\bhttps?:\/\/[^\s"'<>()[\]]+/gi;

const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;

/** Opaque ids hold `-` and `_`. A segment with any other character is not an id. */
const ID_LIKE_RE = /^[A-Za-z0-9_-]+$/;

/** True when a path segment or query value of a link can be an id. */
export function isLinkIdValue(value: string): boolean {
  return ID_LIKE_RE.test(value);
}

/** One link of a text, split into the parts that can hold an identity. */
export interface LinkParts {
  readonly host: string;
  /** The path segments, not decoded, without empty segments. */
  readonly segments: readonly string[];
  /** The query parameters, decoded, in order. */
  readonly query: readonly (readonly [string, string])[];
}

/** Reads one link. `null` when it does not parse. */
function parseLinkParts(raw: string): LinkParts | null {
  let url: URL;

  try {
    // An HTML body writes `&` as `&amp;`.
    url = new URL(raw.replace(TRAILING_PUNCTUATION_RE, "").replaceAll("&amp;", "&"));
  } catch {
    return null;
  }

  return {
    host: normalizeDomain(url.hostname),
    segments: url.pathname.split("/").filter((segment) => segment.length > 0),
    query: [...url.searchParams],
  };
}

/** The links in a text, in order, on any host. A link that does not parse is dropped. */
export function collectLinkParts(text: string): LinkParts[] {
  const links: LinkParts[] = [];

  for (const [raw] of text.matchAll(LINK_RE)) {
    const link = parseLinkParts(raw);

    if (link) links.push(link);
  }

  return links;
}

/**
 * Reads one link. `null` when it does not parse or no provider owns its host. Each path segment is
 * labeled by the segment before it, and each query value by its parameter name.
 */
function parseProviderLink(raw: string): ProviderLink | null {
  const link = parseLinkParts(raw);

  return link && providerLink(link);
}

function providerLink({ host, segments, query }: LinkParts): ProviderLink | null {
  const provider = OBJECT_STATE_PROVIDERS.find((candidate) => isProviderDomain(candidate, host));

  if (!provider) return null;

  const values: ProviderLinkValue[] = [];

  segments.forEach((value, index) => {
    if (isLinkIdValue(value)) values.push({ label: segments[index - 1] ?? null, value });
  });

  for (const [label, value] of query) {
    if (isLinkIdValue(value)) values.push({ label, value });
  }

  return { provider, values };
}

/**
 * The provider links in a text, in order (ADR-0109 rule 2). Each link stays one reference, so a
 * caller can tell which values belong together. A link on no provider domain is dropped.
 */
export function collectProviderLinks(text: string): ProviderLink[] {
  return collectLinkParts(text).flatMap((link) => providerLink(link) ?? []);
}

/**
 * True when `url` is a link of the provider that names this object of `kind`: each declared value
 * sits after its `linkLabel`. For a stored link, such as a webhook permalink. It has no strength
 * floor, because the provider wrote both the link and the values. `false` for a kind that cannot
 * prove a link.
 */
export function linkNamesObject(
  provider: ObjectStateProvider,
  kind: string,
  url: string,
  attributes: Readonly<Record<string, string>>,
): boolean {
  const decl = getObjectDef(provider).kinds[kind]?.identity;
  const link = parseProviderLink(url);

  if (!decl || !identityProvesLink(decl) || link?.provider !== provider) return false;

  return identityAttributes(decl).every((attribute) => {
    const expected = attributes[attribute.attribute];

    return link.values.some(
      ({ label, value }) =>
        label === attribute.linkLabel &&
        expected !== undefined &&
        (value === expected ||
          (attribute.droppedPrefix !== undefined &&
            `${attribute.droppedPrefix}${value}` === expected)),
    );
  });
}
