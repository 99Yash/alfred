import type { LanguageModel } from "ai";
import { resolveModelContextWindow } from "./metering/prices";

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

/** The smallest input window among the models a path may call. */
export async function resolveEffectiveInputWindowTokens({
  models,
  outputReserveTokens = 0,
  fixedInputOverheadTokens = 0,
}: {
  models: readonly LanguageModel[];
  outputReserveTokens?: number;
  fixedInputOverheadTokens?: number;
}): Promise<number> {
  if (models.length === 0) throw new Error("at least one model is required");
  const windows = await Promise.all(models.map((model) => resolveModelContextWindow(model)));

  return effectiveInputWindowTokens({
    contextWindowTokens: Math.min(...windows),
    outputReserveTokens,
    fixedInputOverheadTokens,
  });
}
