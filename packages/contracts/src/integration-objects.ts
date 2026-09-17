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
 * Per-provider definition. `kinds` enumerates the legal `kind` values the DB
 * column holds, and each kind carries its own {@link ObjectKindDef} lifecycle
 * policy, so a kind cannot be added without declaring how it closes;
 * `normalize` maps a reducer-computed native state token to the agnostic
 * bucket.
 */
export interface IntegrationObjectDef {
  readonly kinds: Readonly<Record<string, ObjectKindDef>>;
  /**
   * Prefix-match policy per key kind: the minimum prefix length that may
   * identify an object, for key kinds that support abbreviated lookup (an
   * Actions failure mail's 7-hex short sha). A key kind absent here resolves
   * exactly or not at all. Lives beside the closure policy so a second
   * provider declares it once — the store and the adapters read it rather
   * than each hard-coding their own floor.
   */
  readonly prefixableKeys: Readonly<Record<string, number>>;
  /**
   * Map a provider-native state token (the reducer collapses booleans like
   * `merged` into the token, e.g. `merged`/`closed`/`open` for a github PR) to
   * the agnostic bucket, for one object kind. Each kind has its own token
   * vocabulary (`success`/`failure`/`pending` for a CI attempt or target), so
   * the mapping reads `kind` first. Returns `null` for an unrecognized token —
   * the caller treats unknown as non-closing (absence never closes).
   */
  normalize(kind: string, nativeState: string): StateCategory | null;
}

export const OBJECT_STATE_PROVIDERS = ["github", "sentry"] as const;

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
 * Canonical external id for a GitHub CI target — the thing a check suite
 * closes by succession (`#1093`). The reconciled identity is not the attempt
 * (a suite run never transitions) but the target: `owner/repo` (folded to
 * lower case through the shared identity canonicalizer, which already folds
 * `github_repository_full_name`) plus the head branch, joined by `#`.
 *
 * The branch keeps its case (branch names are case-sensitive) and is trimmed;
 * an empty or over-long branch returns `null`, and callers then fold the
 * attempt alone. A branch that itself holds `#` is vanishingly rare and reads
 * back ambiguously — recorded, not solved.
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
 * Narrow an arbitrary (contract-bounded but provider-open) string to a provider
 * the object-state registry knows. A caller-supplied reference can name a
 * provider that this build does not project, and that must degrade to an honest
 * miss rather than index the registry with an unchecked string.
 */
export const isObjectStateProvider = enumGuard(OBJECT_STATE_PROVIDERS);

/**
 * The registry. GitHub PRs plus the CI succession shape (#1093). A github
 * PR's native state token is one of `open` | `merged` | `closed`
 * (closed-not-merged), collapsed by the reducer from the `pull_request`
 * payload's `state` + `merged` boolean. A CI attempt/target token is one of
 * `success` | `failure` | `pending`, collapsed from the `check_suite`
 * conclusion. A sentry issue's token is one of `unresolved` | `resolved` |
 * `archived`, collapsed by the reducer from the delivery's own EVENT TYPE.
 *
 * `failed` flows from `check_suite` deliveries, which are a typed event in
 * this build but reach production only after the human flips the App
 * subscription (see the PR body): until then the CI kinds stay empty, which
 * is safe — absence never closes. GitHub PR closure rides on merge/close
 * alone — the prod-proven chain.
 */
export const INTEGRATION_OBJECT_DEFS = {
  github: {
    kinds: {
      // A pull request closes by TRANSITION on itself. Only `resolved`
      // (merged) absorbs: a merged PR can never reopen, so even a newer
      // delivery cannot move it out. `abandoned` (closed unmerged) does NOT
      // absorb — a genuine reopen is newer and lands — so recency alone holds
      // it closed against stale redeliveries.
      pull_request: {
        closesAskOn: LOOP_CLOSING_STATE_CATEGORIES,
        absorbing: ["resolved"],
      },
      // A CI attempt closes by SUCCESSION, never by transition: the suite run
      // itself goes nowhere, so an attempt row never closes an ask (only its
      // target does) and never absorbs.
      ci_attempt: {
        closesAskOn: [],
        absorbing: [],
      },
      // The succession target (`owner/repo#branch`): its state is the outcome
      // of the latest attempt. A `resolved` target closes an ask opened by an
      // earlier `failed` target; a later `failed` reopens it; a lone failure
      // stays open. Nothing absorbs, so the store needs no second branch.
      ci_target: {
        closesAskOn: ["resolved"],
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

      // Both CI kinds share the attempt-outcome vocabulary; absence never closes.
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
    },
  },
  sentry: {
    kinds: {
      // A Sentry issue closes by TRANSITION, and every transition is
      // reversible: a resolved issue regresses, an archived issue escalates or
      // is unarchived. So NOTHING absorbs (#1093's empty case) and no later
      // delivery is refused HERE. One delivery can still be dropped upstream:
      // the lifecycle body carries no timestamp and no transition id, so a
      // transition that repeats an earlier one byte for byte digests to the
      // same delivery key and the ingress path answers it `duplicate`. That is
      // an ingress property shared with GitHub, not a policy this table states.
      //
      // `closesAskOn` is empty on purpose (ADR-0103). The store orders by
      // OBSERVATION time, Sentry ships no transition version, and a delayed
      // resolve arriving after an unresolve would falsely restore `resolved`.
      // Until a transition-order proof or a fresh provider read exists, a
      // Sentry state may be projected and displayed but may never suppress an
      // ask. Flip this array when that proof lands; nothing else changes.
      issue: {
        closesAskOn: [],
        absorbing: [],
      },
    },
    // A Sentry issue id is an exact identity or nothing: no abbreviated form
    // of it is written anywhere, so no key kind here supports a prefix lookup.
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
} as const satisfies Record<ObjectStateProvider, IntegrationObjectDef>;

export function getObjectDef(provider: ObjectStateProvider): IntegrationObjectDef {
  return INTEGRATION_OBJECT_DEFS[provider];
}

/**
 * The lifecycle policy for one object kind, or `null` when the provider does
 * not declare that kind. A stored row always names a declared kind; the `null`
 * arm exists because `kind` is a `text` column, so a row written by an older
 * build can name a kind this build no longer has — and because `kind` arrives
 * as an open string, so a prototype key (`constructor`, `__proto__`) must read
 * as undeclared rather than as an `Object.prototype` member (#1093 absorbs
 * that hole on this lane: `closesOpenAsk` over such a key returns `null`
 * instead of throwing).
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
 * The closing category for an already-open ask about an object of this kind,
 * or `null` when this state closes nothing.
 *
 * The single reading reconciliation uses — `reconcileEvidence` calls this
 * rather than testing the category against a global list. An undeclared kind
 * closes nothing: absence never closes (ADR-0048-D).
 *
 * Returns the category rather than a boolean so a caller can record WHICH
 * closure it saw without re-deriving it. A boolean predicate would be unsound
 * here: a kind declaring `closesAskOn: []` returns `false` for `resolved`,
 * and a caller's `else` would then narrow to `"active" | "failed"`.
 */
export function closesOpenAsk(
  provider: ObjectStateProvider,
  kind: string,
  category: StateCategory,
): LoopClosingStateCategory | null {
  const def = getObjectKindDef(provider, kind);

  if (!def) return null;

  for (const closing of def.closesAskOn) {
    if (closing === category) return closing;
  }

  return null;
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

  return def.absorbing.some((c) => c === category);
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
