/**
 * Object-state registry (ADR-0062): each provider's object kinds, key kinds, and
 * how a native state maps to a `StateCategory`. `satisfies` forces a complete
 * definition per provider, which Postgres cannot check.
 */

import { enumGuard } from "./guards";
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
}

export interface IntegrationObjectDef {
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

export const VERCEL_DEPLOYMENT_OUTCOMES = ["success", "failure", "pending"] as const;

export type VercelDeploymentOutcome = (typeof VERCEL_DEPLOYMENT_OUTCOMES)[number];

/**
 * Vercel dispatch action to outcome. Any other action, from any dispatcher, means nothing.
 * `client_payload.state.type` repeats the action suffix, so only the action is read.
 */
const VERCEL_DISPATCH_ACTION_OUTCOMES: ReadonlyMap<string, VercelDeploymentOutcome> = new Map([
  ["vercel.deployment.error", "failure"],
  ["vercel.deployment.success", "success"],
  ["vercel.deployment.ready", "success"],
  ["vercel.deployment.promoted", "success"],
  ["vercel.deployment.pending", "pending"],
]);

/** `null` for an unknown action. It must never read as a success. */
export function vercelDeploymentOutcome(action: string | null): VercelDeploymentOutcome | null {
  if (action === null) return null;

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
    kinds: {
      // Merged absorbs: it can never reopen. Closed-unmerged does not, so a real reopen lands.
      pull_request: {
        closesAskOn: LOOP_CLOSING_STATE_CATEGORIES,
        closesAskFrom: "stored_projection",
        absorbing: ["resolved"],
      },
      // An attempt never closes an ask. Only its target does.
      ci_attempt: {
        closesAskOn: [],
        closesAskFrom: "stored_projection",
        absorbing: [],
      },
      // State is the latest attempt's outcome. A later failure reopens.
      ci_target: {
        closesAskOn: ["resolved"],
        // A check-suite delivery carries `updated_at`, so rows order by provider time.
        closesAskFrom: "stored_projection",
        absorbing: [],
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
    kinds: {
      // Every Sentry transition can reverse, so nothing absorbs. Sentry sends no
      // transition version, so only a live read may close (see `ClosureProof`).
      // `abandoned` stays out: archiving is a triage decision, not a fix.
      issue: {
        closesAskOn: ["resolved"],
        closesAskFrom: "live_confirmation",
        absorbing: [],
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
    kinds: {
      // Like `ci_attempt`: an attempt never closes an ask.
      deployment_attempt: {
        closesAskOn: [],
        closesAskFrom: "stored_projection",
        absorbing: [],
      },
      // Empty `closesAskOn`: no text adapter proposes Railway keys yet, so a closure
      // here is unreachable. Restore `["resolved"]` with that grammar (ADR-0062 amendment).
      deployment_target: {
        closesAskOn: [],
        // The row is the latest authenticated read.
        closesAskFrom: "stored_projection",
        absorbing: [],
      },
    },
    prefixableKeys: {},
    normalize(kind, nativeState) {
      if (kind === "deployment_attempt" || kind === "deployment_target") {
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
  /**
   * Vercel deployments, relayed as GitHub `repository_dispatch` (#1167). GitHub is
   * only the transport. The payload is Vercel's state. Kind names reuse Railway's.
   */
  vercel: {
    kinds: {
      // The fallback when a dispatch has no branch or environment. Never closes an ask.
      deployment_attempt: {
        closesAskOn: [],
        closesAskFrom: "stored_projection",
        absorbing: [],
      },
      // Empty `closesAskOn`, as for Railway: no Vercel mail has ever arrived (#1167),
      // so no text grammar proposes keys yet. Restore `["resolved"]` with one.
      deployment_target: {
        closesAskOn: [],
        // The dispatch carries Vercel's own state, so nothing reorders into a false close.
        closesAskFrom: "stored_projection",
        absorbing: [],
      },
    },
    prefixableKeys: {},
    normalize(kind, nativeState) {
      if (kind === "deployment_attempt" || kind === "deployment_target") {
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
  /**
   * Owner-reviewed MCP connections (#1196). One generic kind: a new MCP service adds
   * a `mcp_health_mapping` row, not code. The mapping emits canonical tokens.
   */
  mcp: {
    kinds: {
      connection_health: {
        closesAskOn: LOOP_CLOSING_STATE_CATEGORIES,
        // Every fold is a live authenticated read, so the row is current.
        closesAskFrom: "stored_projection",
        absorbing: [],
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
