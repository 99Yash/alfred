/**
 * The read route of one call (ADR-0124, amendment 2026-11-18). In a `code_run` run, this one
 * decision sends a call to a script or keeps it direct. Search quotes it, dispatch decides it
 * again for each call, and the broker checks the current descriptor before delivery. No caller
 * keeps its own copy of the table.
 */

import { assertNever, type ToolOutputKind } from "@alfred/contracts";

/** What the runtime knows about the effect and the output of one call. */
export interface ReadFacts {
  /**
   * A confirmed read: Alfred declares it, or an exact descriptor-bound policy or a built-in
   * read-only endpoint confirms it. The read-only hint of a custom server alone is not enough.
   */
  read: boolean;
  /** The trusted declaration of the output. `undefined`: no declaration, so no script. */
  output: ToolOutputKind | undefined;
}

/** The facts of a call that is not a confirmed read. */
export const NOT_A_CONFIRMED_READ: ReadFacts = { read: false, output: undefined };

/** A curated read: `codeModeRead` declares the effect and the structured output together. */
export const DECLARED_STRUCTURED_READ: ReadFacts = { read: true, output: "structured" };

/** Why a call stays a direct call in a `code_run` run. */
export type DirectRouteReason =
  | "not_a_confirmed_read"
  | "binary_output"
  | "undeclared_output"
  | "needs_approval";

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

  switch (route.reason) {
    case "not_a_confirmed_read":
      return "Alfred cannot confirm that it only reads: no built-in read-only endpoint and no exact read policy covers it.";
    case "binary_output":
      return "It returns binary file content, which a script cannot use.";
    case "undeclared_output":
      return "No trusted declaration says that its output is structured.";
    case "needs_approval":
      return "It waits for the user's approval now, and only a direct call shows the approval card.";
    default:
      return assertNever(route.reason, "direct read route reason");
  }
}
