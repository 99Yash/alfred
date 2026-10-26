import type { ModelRouteHandle } from "./provider";

export interface ContextWindowBudget {
  contextWindowTokens: number;
  outputReserveTokens?: number;
  fixedInputOverheadTokens?: number;
}

/** Input room left after output and overhead. Thresholds and fit checks share it, so they agree. */
export function effectiveInputWindowTokens({
  contextWindowTokens,
  outputReserveTokens = 0,
  fixedInputOverheadTokens = 0,
}: ContextWindowBudget): number {
  if (contextWindowTokens <= 0) throw new Error("contextWindowTokens must be positive");

  if (outputReserveTokens < 0) throw new Error("outputReserveTokens must be non-negative");

  if (fixedInputOverheadTokens < 0) {
    throw new Error("fixedInputOverheadTokens must be non-negative");
  }

  return Math.max(0, contextWindowTokens - outputReserveTokens - fixedInputOverheadTokens);
}

export function requestFitsContextWindow(
  inputTokens: number,
  budget: ContextWindowBudget,
): boolean {
  if (inputTokens < 0) throw new Error("inputTokens must be non-negative");

  return inputTokens <= effectiveInputWindowTokens(budget);
}

/** The smallest input window over every leg of every route a path may call. */
export async function resolveEffectiveInputWindowTokens({
  routes,
  outputReserveTokens = 0,
  fixedInputOverheadTokens = 0,
}: {
  routes: readonly ModelRouteHandle[];
  outputReserveTokens?: number;
  fixedInputOverheadTokens?: number;
}): Promise<number> {
  if (routes.length === 0) throw new Error("at least one route is required");
  const windows = await Promise.all(routes.map((handle) => handle.inputWindowTokens()));

  return effectiveInputWindowTokens({
    contextWindowTokens: Math.min(...windows),
    outputReserveTokens,
    fixedInputOverheadTokens,
  });
}
