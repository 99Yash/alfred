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
  return (TERMINAL_STATE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Categories that close an already-open briefing loop. A `failed` object state
 * is terminal for the work object, but it is usually the alert/opener for a CI
 * loop, not evidence that the loop is fixed.
 */
export const LOOP_CLOSING_STATE_CATEGORIES = ["resolved", "abandoned"] as const;
export type LoopClosingStateCategory = (typeof LOOP_CLOSING_STATE_CATEGORIES)[number];

export function isLoopClosingCategory(
  category: StateCategory,
): category is LoopClosingStateCategory {
  return (LOOP_CLOSING_STATE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Per-provider definition. `kinds` / `keyKinds` enumerate the legal `text`
 * values the DB columns hold; `keyResolvesTo` declares which kind a key kind
 * points at (`head_sha → pull_request`, never `→ issue`); `normalize` maps a
 * reducer-computed native state token to the agnostic bucket.
 */
export interface IntegrationObjectDef {
  readonly kinds: readonly string[];
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
    kinds: ["pull_request"],
    keyKinds: ["head_sha"],
    keyResolvesTo: { head_sha: "pull_request" },
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
