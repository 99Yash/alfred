/**
 * Object state (ADR-0062): the readers over the kinds that each source declares on its registry
 * entry (ADR-0122 decision 1), and the canonical keys of each kind. The vocabulary of a kind is in
 * `./object-kind`.
 */

import { emailDomain, isDomainOrSubdomain, normalizeDomain } from "./domain";
import { enumGuard, parseEmailAddress } from "./guards";
import { INTEGRATIONS } from "./integrations/registry";
import {
  LOOP_CLOSING_STATE_CATEGORIES,
  type ClosureProof,
  type DeploymentStatus,
  type IdentityAttribute,
  type LoopClosingStateCategory,
  type ObjectIdentityDecl,
  type ObjectKindDef,
  type SourceDecl,
  type StateCategory,
} from "./object-kind";
import {
  OBJECT_STATE_PROVIDERS,
  type BuiltInSourceSlug,
  type ObjectStateProvider,
} from "./object-state-vocabulary";
import { canonicalizeIdentityValue } from "./user-model";

/**
 * How a producer knows an object state (#1094). Text evidence is not a member:
 * it may trigger a pull, never assert. No store branch reads this.
 */
export const OBJECT_STATE_CLOSURE_SOURCES = ["verified_push", "verified_pull"] as const;

export type ClosureSource = (typeof OBJECT_STATE_CLOSURE_SOURCES)[number];

/** A live read satisfies every kind. */
const PROOF_STRENGTH = {
  stored_projection: 0,
  live_confirmation: 1,
} satisfies Record<ClosureProof, number>;

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
 * Owner-reviewed MCP connections (#1196). One generic kind: a new MCP service adds a
 * `mcp_health_mapping` row, not code. The mapping emits canonical tokens. It leaves this file when
 * the MCP rows take a `SourceIdentity` and a kind preset (ADR-0118 decisions 2 and 5).
 */
const MCP_HEALTH_SOURCE = {
  // MCP identities come only from an owner-approved live read, never from mail.
  domains: [],
  kinds: {
    connection_health: {
      closesAskOn: LOOP_CLOSING_STATE_CATEGORIES,
      // Every fold is a live authenticated read, so the row is current.
      closesAskFrom: "stored_projection",
      absorbing: [],
      todoIdentity: false,
      states: { active: "active", resolved: "resolved", failed: "failed", abandoned: "abandoned" },
    },
  },
  prefixableKeys: {},
} as const satisfies SourceDecl;

/** What a provider declares, with its literal kind names. */
type SourceDeclOf<P extends ObjectStateProvider> = P extends BuiltInSourceSlug
  ? (typeof INTEGRATIONS)[P]["source"]
  : typeof MCP_HEALTH_SOURCE;

/** The kinds that a provider declares, so a table keyed by kind stays complete. */
export type ObjectKindOf<P extends ObjectStateProvider> = keyof SourceDeclOf<P>["kinds"] & string;

/** The object state that a provider declares (ADR-0122 decision 1). */
export function getObjectDef(provider: ObjectStateProvider): SourceDecl {
  return provider === "mcp" ? MCP_HEALTH_SOURCE : INTEGRATIONS[provider].source;
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
 * The category of a native state token for one kind. `null` for an undeclared kind or token, which
 * never closes. `nativeState` is open text, so a prototype key must read as undeclared.
 */
export function stateCategoryOf(
  provider: ObjectStateProvider,
  kind: string,
  nativeState: string,
): StateCategory | null {
  const states = getObjectKindDef(provider, kind)?.states;

  if (!states || !Object.prototype.hasOwnProperty.call(states, nativeState)) return null;

  return states[nativeState] ?? null;
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

/** True when `domain` is one of the provider's declared {@link SourceDecl.domains}. */
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
