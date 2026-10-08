import { canonicalParamKey, isRecord } from "@alfred/contracts";
import type { z } from "zod";
import { acceptedParamNames } from "./invalid-input";

/**
 * Rename a model key that differs from a schema key only in case or `_`/`-`
 * (`max_results` to `maxResults`, both directions). Runs before `safeParse`.
 * An ambiguous form is left alone, and a rename never overwrites a key the model set.
 */

export interface KeyNormalizationResult {
  input: unknown;
  renamed: { from: string; to: string }[];
}

export function normalizeToolInputKeys(
  input: unknown,
  schema: z.ZodType<any>,
): KeyNormalizationResult {
  if (!isRecord(input)) return { input, renamed: [] };
  const accepted = acceptedParamNames(schema);

  if (accepted.length === 0) return { input, renamed: [] };

  const acceptedSet = new Set(accepted);
  // null marks a form that two accepted keys share.
  const canonToKey = new Map<string, string | null>();

  for (const key of accepted) {
    const c = canonicalParamKey(key);
    canonToKey.set(c, canonToKey.has(c) ? null : key);
  }

  const renamed: { from: string; to: string }[] = [];
  let next = input;

  for (const key of Object.keys(input)) {
    if (acceptedSet.has(key)) continue;
    const target = canonToKey.get(canonicalParamKey(key));

    if (!target) continue;

    if (target in next) continue;

    if (next === input) next = { ...input };
    next[target] = next[key];
    delete next[key];
    renamed.push({ from: key, to: target });
  }

  return { input: next, renamed };
}
