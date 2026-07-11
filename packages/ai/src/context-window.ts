import type { LanguageModel } from "ai";
import { resolveModelContextWindow } from "./metering/prices";

export interface ContextWindowBudget {
  contextWindowTokens: number;
  outputReserveTokens?: number;
  fixedInputOverheadTokens?: number;
}

/**
 * Input capacity left after reserving output and fixed request overhead. Keep
 * this arithmetic shared by pressure thresholds and hard fit checks so a call
 * cannot reserve one shape while its guard reasons about another.
 */
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

/** Resolve the smallest effective input window across every model a path may call. */
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
