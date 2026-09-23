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
 * The NAMED closure sources: the verified ways object state may assert
 * closure of an already-open ask (#1094). A verified push is a provider event
 * delivered over a verified webhook and folded by the per-provider reducer; a
 * verified pull is an authenticated read of current deployment state taken at
 * gather time over a user-connected grant. Untrusted text evidence is
 * deliberately NOT a member — it can trigger a pull, never assert — so a kind
 * of knowing the pull cannot name cannot be declared.
 *
 * Naming, not a gate (tier 3): `ObjectStateDelta.closureSource` is required,
 * so every producer declares how it knows, but no store branch reads it —
 * policy stays per-kind in `closesOpenAsk`.
 */
export const OBJECT_STATE_CLOSURE_SOURCES = ["verified_push", "verified_pull"] as const;

export type ClosureSource = (typeof OBJECT_STATE_CLOSURE_SOURCES)[number];

/**
 * How strong a reading of current state must be before it may ASSERT closure
 * of an already-open ask, per object KIND (ADR-0103).
 *
 * - `stored_projection` — the store's own row is enough. Sound only where the
 *   projection cannot be wrong about current state: a kind that closes by
 *   TRANSITION and absorbs its closing state (a merged pull request), or one
 *   whose row IS the latest authenticated read.
 * - `live_confirmation` — the row may only NOMINATE a candidate, and closure
 *   needs a read of provider state taken at the moment closure is asserted. A
 *   kind whose deliveries carry no transition version needs this: the store
 *   orders by OBSERVATION time, so a delayed resolve arriving after an
 *   unresolve would falsely restore `resolved` (`sentry.issue`).
 *
 * A gate, not naming (tier 2, unlike {@link ClosureSource} above):
 * {@link closesOpenAsk} takes the proof the caller actually HOLDS as a
 * required argument. A synchronous reader with no IO — `evidenceObjectClosesAsk`
 * over an evidence card — can therefore only ever pass `stored_projection`,
 * and reads a `live_confirmation` kind as closing nothing. That is what stops
 * one per-kind flag from answering two different questions: "is this a
 * closure candidate" belongs to {@link closureCandidate}, and only a caller
 * that went and got the proof may assert.
 */
export const CLOSURE_PROOFS = ["stored_projection", "live_confirmation"] as const;

export type ClosureProof = (typeof CLOSURE_PROOFS)[number];

/**
 * Proof strength, ordered: a live read is strictly stronger than the stored
 * projection, so it satisfies every kind. `satisfies` over the vocabulary, so
 * a third proof is a compile error here instead of a silent `undefined`
 * comparison.
 */
const PROOF_STRENGTH = {
  stored_projection: 0,
  live_confirmation: 1,
} satisfies Record<ClosureProof, number>;

/**
 * Per-KIND lifecycle policy. Two rules that generic code must not hard-code,
 * because they differ per kind rather than per provider (#1088, #1093):
 *
 * - `closesAskOn` — which categories close an already-open ask about an object
 *   of this kind. A pull request closes on `resolved` (merged) and `abandoned`
 *   (closed unmerged).
 * - `closesAskFrom` — the weakest reading that may ASSERT those categories
 *   (see {@link ClosureProof}). Required with no default, so a kind cannot be
 *   added, and an empty `closesAskOn` cannot be filled, without deciding
 *   whether stored state proves the closure or a live read has to.
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
  readonly closesAskFrom: ClosureProof;
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

export const OBJECT_STATE_PROVIDERS = ["github", "sentry", "railway", "vercel"] as const;

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
 * The inverse of {@link canonicalizeGithubPullRequestUrl} for readers that
 * need the API coordinates, not the key: `{ repoFullName, number }` for a
 * canonical PR URL, or null. It parses the CANONICAL form (after validation),
 * never the raw input, so the grammar stays in {@link GITHUB_PULL_REQUEST_URL_RE}.
 */
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
 * Canonical external id for a Railway deployment target — the thing a
 * verified pull closes by succession (`#1094`). Railway mails a build failure
 * and stays silent on success, so no push can ever observe the recovery; the
 * reconciled identity is the target the pull reads: `projectId/serviceId/
 * environmentId`, joined from the provider's own opaque ids.
 *
 * No case folding: these are opaque ids, not names. Any part empty returns
 * `null`, and callers then fold the attempt alone.
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
 * The branch a git ref names, or `null` when the ref names something that is
 * not a branch.
 *
 * A dispatcher writes `client_payload.git.ref` itself, so the value arrives in
 * whichever of git's two spellings that dispatcher chose: the short name
 * (`main`) or the full ref (`refs/heads/main`). Both spell ONE branch, so both
 * must reduce to one identity — otherwise a single deployment target splits in
 * two and neither half ever closes the other's ask.
 *
 * Anything still under `refs/` after the branch prefix comes off is a tag, a
 * pull ref or a note. None of those is a branch, so none of them names a
 * deployment target: the caller folds the attempt alone rather than minting a
 * target identity out of a ref it cannot read (absence never closes).
 *
 * Idempotent, so a caller that normalizes first and a caller that does not
 * reach the same value.
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
 * Canonical external id for a Vercel deployment target — the thing a relayed
 * deployment dispatch closes by succession (#1167): `owner/repo#branch#env`.
 *
 * The first two segments delegate to {@link canonicalizeGithubTargetId}, so
 * the repo grammar and the case fold are declared ONCE. The third segment is
 * Vercel's own `environment` (`production` / `preview`), which is what keeps a
 * preview deploy from folding into the production target of the same branch.
 *
 * A separate function rather than an optional third argument on the github
 * canonicalizer: one helper serving two identity spaces lets a caller that
 * omits the argument silently mint a `ci_target` id under a vercel kind.
 *
 * `branch` is the DEPLOYMENT's branch (`client_payload.git.ref`), never
 * `repository_dispatch`'s top-level `branch` — GitHub always dispatches
 * against the default branch, so that field reads `main` for a preview deploy
 * of any feature branch. Measured on all 15 dev receipts.
 *
 * It arrives as a raw ref, so {@link parseGitBranchRef} runs here rather than
 * only at the call site: the id grammar owns the fold from `refs/heads/main`
 * to `main`, and a second caller cannot bypass it. A ref that names no branch
 * returns `null`.
 *
 * Any segment empty or unparseable returns `null`; callers then fold the
 * attempt alone.
 */
export function canonicalizeVercelTargetId(input: {
  repoFullName: string;
  branch: string;
  environment: string;
}): string | null {
  const branch = parseGitBranchRef(input.branch);

  if (!branch) return null;

  // The id joins three segments with `#`, and it is read back by splitting on
  // the last one. A `#` inside either of the two tail segments makes that
  // split ambiguous, so neither may carry one.
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
 * The outcome vocabulary a Vercel deployment dispatch collapses to — the
 * `nativeState` the `vercel` registry entry below normalizes, and the one the
 * activity line reads. Declared ONCE, here, so the reducer and the
 * description cannot encode the same action table twice and drift apart.
 */
export const VERCEL_DEPLOYMENT_OUTCOMES = ["success", "failure", "pending"] as const;

export type VercelDeploymentOutcome = (typeof VERCEL_DEPLOYMENT_OUTCOMES)[number];

/**
 * The `repository_dispatch` actions Vercel sends, collapsed to that
 * vocabulary. A const table rather than a switch so an action outside it —
 * including a `repository_dispatch` from some other dispatcher entirely —
 * reads as `null` and means nothing, neither a fold nor a green line.
 *
 * `client_payload.state.type` duplicates the action suffix on every receipt
 * measured, so the action alone is read: one field, one authority.
 */
const VERCEL_DISPATCH_ACTION_OUTCOMES: ReadonlyMap<string, VercelDeploymentOutcome> = new Map([
  ["vercel.deployment.error", "failure"],
  ["vercel.deployment.success", "success"],
  ["vercel.deployment.ready", "success"],
  ["vercel.deployment.promoted", "success"],
  ["vercel.deployment.pending", "pending"],
]);

/**
 * What a `repository_dispatch` action means, or `null` when this build does
 * not recognize it. Every reader of a dispatch outcome goes through here:
 * absence must read as absence, never as a succeeded deployment.
 */
export function vercelDeploymentOutcome(action: string | null): VercelDeploymentOutcome | null {
  if (action === null) return null;

  return VERCEL_DISPATCH_ACTION_OUTCOMES.get(action) ?? null;
}

/**
 * Narrow an arbitrary (contract-bounded but provider-open) string to a provider
 * the object-state registry knows. A caller-supplied reference can name a
 * provider that this build does not project, and that must degrade to an honest
 * miss rather than index the registry with an unchecked string.
 */
export const isObjectStateProvider = enumGuard(OBJECT_STATE_PROVIDERS);

/**
 * A Sentry issue's stored native token — the vocabulary the webhook reducer
 * writes and `INTEGRATION_OBJECT_DEFS.sentry.normalize` reads.
 *
 * It is declared here, not in the reducer, because a SECOND producer writes it:
 * the live issue read behind `closesAskFrom: "live_confirmation"` (ADR-0103).
 * That producer reads Sentry's REST API, whose `status` field is a DIFFERENT
 * vocabulary — `resolved` | `unresolved` | `ignored`, where this one says
 * `archived` — so the live boundary must translate rather than pass through.
 * One declaration keeps the two producers and the one reader from drifting
 * apart on a token that decides whether an ask closes.
 */
export const SENTRY_ISSUE_NATIVE_STATES = ["unresolved", "resolved", "archived"] as const;

export type SentryIssueNativeState = (typeof SENTRY_ISSUE_NATIVE_STATES)[number];

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
 * alone — the prod-proven chain. A Railway deployment token is one of
 * `success` | `failure` | `pending`, collapsed by the verified-pull seam from
 * the deployment status the authenticated read returns (#1094).
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
        // Stored state proves it: `resolved` absorbs, so no later delivery
        // and no reorder can make a merged PR unmerged.
        closesAskFrom: "stored_projection",
        absorbing: ["resolved"],
      },
      // A CI attempt closes by SUCCESSION, never by transition: the suite run
      // itself goes nowhere, so an attempt row never closes an ask (only its
      // target does) and never absorbs.
      ci_attempt: {
        closesAskOn: [],
        closesAskFrom: "stored_projection",
        absorbing: [],
      },
      // The succession target (`owner/repo#branch`): its state is the outcome
      // of the latest attempt. A `resolved` target closes an ask opened by an
      // earlier `failed` target; a later `failed` reopens it; a lone failure
      // stays open. Nothing absorbs, so the store needs no second branch.
      ci_target: {
        closesAskOn: ["resolved"],
        // Stored state proves it: a check-suite delivery carries a provider
        // clock (`updated_at`), so the row already orders by provider event
        // time rather than by observation time.
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

      // Both CI kinds share the attempt-outcome vocabulary. The kind arm is
      // explicit so a future kind (e.g. a deployment) cannot silently inherit
      // it: an unlisted kind reads as unknown, and absence never closes.
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
      // A Sentry issue closes by TRANSITION, and every transition is
      // reversible: a resolved issue regresses, an archived issue escalates or
      // is unarchived. So NOTHING absorbs (#1093's empty case) and no later
      // delivery is refused HERE. One delivery can still be dropped upstream:
      // the lifecycle body carries no timestamp and no transition id, so a
      // transition that repeats an earlier one byte for byte digests to the
      // same delivery key and the ingress path answers it `duplicate`. That is
      // an ingress property shared with GitHub, not a policy this table states.
      //
      // `closesAskOn: ["resolved"]` with `closesAskFrom: "live_confirmation"`
      // (ADR-0103). The store orders by OBSERVATION time and Sentry ships no
      // transition version, so stored `resolved` alone may never assert a
      // closure — a delayed resolve arriving after an unresolve would falsely
      // restore it. The proof declaration is what enforces that, not a comment
      // and not a branch in one consumer: every asserter passes the reading it
      // holds to `closesOpenAsk`, so the synchronous card reader
      // (`evidenceObjectClosesAsk`) closes nothing here, and only
      // `dropClosedLoops` (briefings/gather.ts) — which takes a live issue read
      // under the stored org credential — can close. Any other live status, or
      // a read failure, keeps the ask. `abandoned` stays out: an archived issue
      // is a triage decision, not a fix, and the archive policy is unreviewed.
      issue: {
        closesAskOn: ["resolved"],
        // The whole point of the pair above: a live read at assertion time,
        // never the stored row. The sync card reader cannot take one, so it
        // reads this kind as closing nothing.
        closesAskFrom: "live_confirmation",
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
  railway: {
    kinds: {
      // A Railway deployment attempt closes by SUCCESSION, never by
      // transition: one deployment goes nowhere, so an attempt row never
      // closes an ask (only its target does) and never absorbs. Mirrors
      // `ci_attempt` (#1093).
      deployment_attempt: {
        closesAskOn: [],
        closesAskFrom: "stored_projection",
        absorbing: [],
      },
      // The succession target (`projectId/serviceId/environmentId`): its
      // state is the outcome of the latest verified pull. Nothing absorbs,
      // so a success after a failure lands as ordinary traffic.
      //
      // `closesAskOn` is empty until the Railway text adapter exists: the
      // adapter proposes no keys, so no Railway row reaches the closure
      // reader and a declaration here would be unreachable. Closure to the
      // reader is the pull's verdict line, not a dropped email loop. Restore
      // `["resolved"]` alongside the deployment-URL grammar that makes it
      // reachable (ADR-0062 amendment 2026-09-20).
      deployment_target: {
        closesAskOn: [],
        // The row IS the latest authenticated read (`verified_pull` at gather
        // time), so stored state will prove the restored `["resolved"]`.
        closesAskFrom: "stored_projection",
        absorbing: [],
      },
    },
    // Railway ids are exact opaque identities: no abbreviated form of one is
    // written anywhere, so no key kind here supports a prefix lookup.
    prefixableKeys: {},
    normalize(kind, nativeState) {
      // Both deployment kinds share the pull-collapsed outcome vocabulary.
      // The kind arm is explicit so a future kind cannot silently inherit it:
      // an unlisted kind reads as unknown, and absence never closes.
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
   * Vercel deployments, relayed as GitHub `repository_dispatch` (#1167).
   * GitHub is only the transport: the `client_payload` is Vercel's own
   * deployment state, so the object is a VERCEL object and `vercel` is
   * already a live `INTEGRATIONS` slug.
   *
   * ADR-0103's "one receipt may produce deltas for its own provider" sits in
   * the `projectReceipt` paragraph, which that ADR itself lists as still
   * open; the built path is `objectStateStore.applyEvent`, which takes the
   * provider as an argument. The clause's stated purpose — one provider's
   * transition must not rewrite another's native state — is untouched here:
   * nothing propagates, the payload IS Vercel's state, written once.
   *
   * The kind names are Railway's, deliberately. Kinds are namespaced by
   * `(provider, kind, external_id)`, so reusing them adds no vocabulary.
   */
  vercel: {
    kinds: {
      // One deployment attempt (`deployment:<client_payload.id>`). Closes by
      // SUCCESSION, never by transition: the attempt itself goes nowhere, so
      // it never closes an ask (only its target does) and never absorbs.
      // It exists as the degradation path — a dispatch with no branch or no
      // environment folds its attempt alone rather than vanishing.
      deployment_attempt: {
        closesAskOn: [],
        closesAskFrom: "stored_projection",
        absorbing: [],
      },
      // The succession target (`owner/repo#branch#environment`): its state is
      // the outcome of the latest deployment. Nothing absorbs, so a later
      // failure after a success reopens as ordinary traffic and a lone
      // failure stays open.
      //
      // `closesAskOn` is empty for the same reason Railway's is, and the same
      // measurement backs it: the adapter proposes no keys, so no vercel row
      // can reach the closure reader and a declaration here would be
      // unreachable. No Vercel deployment notification has ever reached this
      // mailbox (#1167, measured 2026-09-20) — there is no written form to
      // ground a grammar on. Restore `["resolved"]` together with the mail
      // grammar that makes it reachable.
      deployment_target: {
        closesAskOn: [],
        // A dispatch carries Vercel's own state for one deployment and the
        // target succeeds rather than transitions, so nothing reorders into a
        // false close: stored state will prove the restored `["resolved"]`.
        closesAskFrom: "stored_projection",
        absorbing: [],
      },
    },
    // Vercel deployment ids are exact opaque identities and the target id is
    // a joined name: no abbreviated form of either is written anywhere.
    prefixableKeys: {},
    normalize(kind, nativeState) {
      // Both deployment kinds share the dispatch-collapsed outcome
      // vocabulary. The kind arm is explicit so a future kind cannot silently
      // inherit it: an unlisted kind reads as unknown, and absence never
      // closes.
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
 * The closure this kind's state WOULD assert, and the proof an asserter must
 * hold first, or `null` when the state closes nothing for this kind.
 *
 * For a NOMINATOR: a caller that resolves stored state and hands the candidate
 * to whoever can go get that proof (`reconcileEvidence` proposes, the briefing
 * drop confirms). An undeclared kind closes nothing: absence never closes
 * (ADR-0048-D).
 *
 * A nominator must not write this into user- or model-facing text. That is an
 * ASSERTION, and an assertion reads {@link closesOpenAsk} with the proof it
 * actually holds — a `live_confirmation` kind's stored `resolved` is a
 * question, not an answer (ADR-0103).
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
 * The closing category for an already-open ask about an object of this kind,
 * or `null` when this state closes nothing — or when the reading the caller
 * holds is too weak to assert it.
 *
 * The single reading an ASSERTER uses. `proof` names what the caller actually
 * read, and it is required for the reason the whole {@link ClosureProof} split
 * exists: a synchronous card reader with no IO can only pass
 * `stored_projection`, so a kind declaring `closesAskFrom:
 * "live_confirmation"` closes nothing for it, and only the caller that took a
 * live read may pass `live_confirmation` and close.
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
  proof: ClosureProof,
): LoopClosingStateCategory | null {
  const candidate = closureCandidate(provider, kind, category);

  if (!candidate) return null;

  if (PROOF_STRENGTH[proof] < PROOF_STRENGTH[candidate.proof]) return null;

  return candidate.closesAskAs;
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
