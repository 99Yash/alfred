/**
 * The read route of one call (ADR-0124, amendment 2026-11-18). In a `code_run` run, this one
 * decision sends a call to a script or keeps it direct. Discovery quotes it (`route-quote.ts`,
 * ADR-0130 C1), dispatch decides it again for each call, and the broker checks the current
 * descriptor before delivery. No caller keeps its own copy of the table.
 */

import {
  DIRECT_READ_ROUTE_REASON_TEXT,
  type DirectRouteReason,
  type ToolOutputKind,
  type ToolReadClass,
} from "@alfred/contracts";

/** What the runtime knows about the effect, the output, and the class of one call. */
export type ReadFacts =
  | {
      /**
       * A confirmed read: Alfred declares it, or an exact descriptor-bound policy or a built-in
       * read-only endpoint confirms it. The read-only hint of a custom server alone is not enough.
       */
      read: true;
      /** The trusted declaration of the output. `undefined`: no declaration, so no script. */
      output: ToolOutputKind | undefined;
      /**
       * The read class (ADR-0130 decision 1). `undefined`: no code classifies the read, so it asks
       * under `gated` as a `secret` read does.
       */
      readClass: ToolReadClass | undefined;
    }
  | { read: false; output: undefined; readClass: undefined };

/** The facts of a call that is not a confirmed read. */
export const NOT_A_CONFIRMED_READ: ReadFacts = {
  read: false,
  output: undefined,
  readClass: undefined,
};

/**
 * A curated read: `codeModeRead` declares the effect, the structured output, and the class
 * together.
 */
export function declaredStructuredRead(readClass: ToolReadClass): ReadFacts {
  return { read: true, output: "structured", readClass };
}

export type ReadRoute = { route: "script" } | { route: "direct"; reason: DirectRouteReason };

/**
 * The route table. `requiresApproval` is the live approval of the call: its staging arm, its
 * policy and tier, and the thread's Full Autonomy. A read with no card goes to the script, so a
 * `fast_path` catalog read is a script read.
 */
export function decideReadRoute(facts: ReadFacts, requiresApproval: boolean): ReadRoute {
  if (!facts.read) return { route: "direct", reason: "not_a_confirmed_read" };

  if (facts.output === "binary") return { route: "direct", reason: "binary_output" };

  if (facts.output === undefined) return { route: "direct", reason: "undeclared_output" };

  if (requiresApproval) return { route: "direct", reason: "needs_approval" };

  return { route: "script" };
}

/** The reason of a route, for a refusal that tells the model where the call runs now. */
export function readRouteReasonText(route: ReadRoute): string {
  if (route.route === "script") {
    return "It is a confirmed read with structured output, and it needs no approval now.";
  }

  return DIRECT_READ_ROUTE_REASON_TEXT[route.reason];
}
