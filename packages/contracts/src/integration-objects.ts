/**
 * Integration object-state registry (ADR-0062, #212).
 *
 * The typed SSOT for external work-object lifecycle: which object kinds and key
 * kinds each provider has, and how a provider-native state maps to the
 * agnostic `StateCategory` bucket. Declared `as const satisfies` so adding a
 * provider is a compile-forced complete definition — the generalization of
 * ADR-0053 ("which tools exist") to "which object kinds/keys/states each
 * provider has". This is precisely the constraint Postgres cannot enforce (an
 * enum-per-provider, a key-kind-per-provider), enforced at the type layer.
 *
 * Pure module — no Node imports (consumed across the web boundary).
 */

import { enumGuard } from "./guards";
import { canonicalizeIdentityValue } from "./user-model";

/** Provider-agnostic lifecycle bucket. Generic consumers (briefing reconciliation) read this. */
export const OBJECT_STATE_CATEGORIES = ["active", "resolved", "failed", "abandoned"] as const;

export type StateCategory = (typeof OBJECT_STATE_CATEGORIES)[number];

/**
 * Terminal categories — a briefing loop closes ONLY on one of these (the
 * positive side of ADR-0048-D's contract; the *absence* of a terminal state
 * never closes). `active` is the sole non-terminal bucket.
 */
export const TERMINAL_STATE_CATEGORIES = ["resolved", "failed", "abandoned"] as const;

export type TerminalStateCategory = (typeof TERMINAL_STATE_CATEGORIES)[number];

export function isTerminalCategory(category: StateCategory): category is TerminalStateCategory {
  // SAFETY: the tuple is a const list of StateCategory literals; widening to
  // readonly string[] only types the .includes receiver for this narrowing
  // predicate.
  return (TERMINAL_STATE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * The vocabulary of closure: the categories that MAY close an already-open ask
 * about a work object. A `failed` object state is terminal for the work object,
 * but it is usually the alert/opener for a CI loop, not evidence that the loop
 * is fixed, so it is not in this list.
 *
 * Which of these actually close an ask is per OBJECT KIND, not global — read
 * {@link closesOpenAsk}, never this tuple, to decide a closure. The tuple is
 * the bound a kind declares within (`briefingClosedLoopSchema` types its rows
 * from it), not the rule.
 */
export const LOOP_CLOSING_STATE_CATEGORIES = ["resolved", "abandoned"] as const;

export type LoopClosingStateCategory = (typeof LOOP_CLOSING_STATE_CATEGORIES)[number];

/**
 * Per-KIND lifecycle policy. Two rules that generic code must not hard-code,
 * because they differ per kind rather than per provider (#1088, #1093):
 *
 * - `closesAskOn` — which categories close an already-open ask about an object
 *   of this kind. A pull request closes on `resolved` (merged) and `abandoned`
 *   (closed unmerged).
 * - `absorbing` — which categories, once reached, no later delivery may move
 *   the object out of. A merged pull request stays merged, so a delayed
 *   `synchronize` delivery cannot regress it to `active`.
 *
 * `absorbing` is deliberately a per-kind LIST and not the global rule
 * "`resolved` absorbs". Work that closes by SUCCESSION rather than by
 * transition — a CI run, a deployment — is never monotonic: a success does not
 * absorb, and a later failure is normal traffic (#1093). Such a kind declares
 * `absorbing: []`, and neither the store nor a consumer needs a second branch
 * for it.
 */
export interface ObjectKindDef {
  readonly closesAskOn: readonly LoopClosingStateCategory[];
  readonly absorbing: readonly StateCategory[];
}

/**
 * Per-provider definition. `kinds` / `keyKinds` enumerate the legal `text`
 * values the DB columns hold, and each kind carries its own
 * {@link ObjectKindDef} lifecycle policy, so a kind cannot be added without
 * declaring how it closes; `keyResolvesTo` declares which kind a key kind
 * points at (`head_sha → pull_request`, never `→ issue`); `normalize` maps a
 * reducer-computed native state token to the agnostic bucket.
 */
export interface IntegrationObjectDef {
  readonly kinds: Readonly<Record<string, ObjectKindDef>>;
  readonly keyKinds: readonly string[];
  /** key_kind → the object kind it resolves to. */
  readonly keyResolvesTo: Readonly<Record<string, string>>;
  /**
   * Map a provider-native state token (the reducer collapses booleans like
   * `merged` into the token, e.g. `merged`/`closed`/`open` for a github PR) to
   * the agnostic bucket. Returns `null` for an unrecognized token — the caller
   * treats unknown as non-closing (absence never closes).
   */
  normalize(kind: string, nativeState: string): StateCategory | null;
}

export const OBJECT_STATE_PROVIDERS = ["github"] as const;

export type ObjectStateProvider = (typeof OBJECT_STATE_PROVIDERS)[number];

const GITHUB_PULL_REQUEST_URL_RE =
  /^https?:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/**
 * Canonical value stored for GitHub's `pull_request_url` object key.
 *
 * GitHub repository names are case-insensitive, so both webhook URLs and
 * notification-email references fold to the same lower-case URL. Invalid or
 * non-PR inputs return `null`; callers then preserve the object as unresolved.
 */
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

/**
 * Narrow an arbitrary (contract-bounded but provider-open) string to a provider
 * the object-state registry knows. A caller-supplied reference can name a
 * provider that this build does not project, and that must degrade to an honest
 * miss rather than index the registry with an unchecked string.
 */
export const isObjectStateProvider = enumGuard(OBJECT_STATE_PROVIDERS);

/**
 * The registry. v1 = GitHub PR/CI only. A github PR's native state token is one
 * of `open` | `merged` | `closed` (closed-not-merged), collapsed by the reducer
 * from the `pull_request` payload's `state` + `merged` boolean.
 *
 * `failed` is reserved (the agnostic bucket exists) but unreachable in v1: it
 * would come from `check_suite` deliveries, which the App does not yet
 * subscribe to. Closure rides on PR merge/close alone — the prod-proven chain.
 */
export const INTEGRATION_OBJECT_DEFS = {
  github: {
    kinds: {
      // A pull request closes by TRANSITION on itself, and its terminal states
      // are final: merged stays merged, closed stays closed until a reopen
      // delivery says otherwise (`open` is not absorbing, so a reopen lands).
      pull_request: {
        closesAskOn: LOOP_CLOSING_STATE_CATEGORIES,
        absorbing: ["resolved"],
      },
    },
    keyKinds: ["head_sha", "pull_request_url"],
    keyResolvesTo: { head_sha: "pull_request", pull_request_url: "pull_request" },
    normalize(_kind, nativeState) {
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
    },
  },
} as const satisfies Record<ObjectStateProvider, IntegrationObjectDef>;

export function getObjectDef(provider: ObjectStateProvider): IntegrationObjectDef {
  return INTEGRATION_OBJECT_DEFS[provider];
}

/**
 * The lifecycle policy for one object kind, or `null` when the provider does
 * not declare that kind. A stored row always names a declared kind; the `null`
 * arm exists because `kind` is a `text` column, so a row written by an older
 * build can name a kind this build no longer has.
 */
export function getObjectKindDef(
  provider: ObjectStateProvider,
  kind: string,
): ObjectKindDef | null {
  return getObjectDef(provider).kinds[kind] ?? null;
}

/**
 * Does this state close an already-open ask about an object of this kind?
 *
 * The single reading every consumer uses — the briefing loop reconciliation,
 * the pre-send open-ask guard, and Context Search enrichment all call this
 * rather than testing the category against a global list. An undeclared kind
 * closes nothing: absence never closes (ADR-0048-D).
 */
export function closesOpenAsk(
  provider: ObjectStateProvider,
  kind: string,
  category: StateCategory,
): category is LoopClosingStateCategory {
  const def = getObjectKindDef(provider, kind);

  if (!def) return false;

  // SAFETY: the declared list is a const list of LoopClosingStateCategory
  // literals; widening to readonly string[] only types the .includes receiver
  // for this narrowing predicate.
  return (def.closesAskOn as readonly string[]).includes(category);
}

/**
 * Is this state final for an object of this kind — a state no later delivery
 * may move it out of?
 *
 * The store's write guard reads this instead of hard-coding "`resolved`
 * absorbs", so a kind whose state is the outcome of its latest attempt
 * declares `absorbing: []` and reopens normally (#1093). `category` is the raw
 * `text` column value, so an unrecognized token absorbs nothing.
 */
export function isAbsorbingState(
  provider: ObjectStateProvider,
  kind: string,
  category: string,
): boolean {
  const def = getObjectKindDef(provider, kind);

  if (!def) return false;

  return (def.absorbing as readonly string[]).includes(category);
}

/**
 * Every GitHub pull-request identity a free-text blob names, as canonical URLs
 * in first-seen order. Two written forms resolve to one identity: the full
 * `https://github.com/<owner>/<repo>/pull/<number>` URL, and the
 * `<owner>/<repo>#<number>` shorthand.
 *
 * Pure and total — it reports what the text names and nothing more. A caller
 * that needs a SINGLE identity (a notification's own object) checks the length
 * itself; a caller that needs every mention (the briefing pre-send guard) reads
 * the whole list.
 */
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
