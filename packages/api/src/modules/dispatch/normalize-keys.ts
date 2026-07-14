import { isRecord } from "@alfred/contracts";
import type { z } from "zod";
import { acceptedParamNames } from "./invalid-input";

/**
 * General, direction-agnostic tool-input key normalizer (param-ergonomics pass).
 *
 * The dominant cross-integration tool-call failure is not the query DSL but the
 * *parameter surface*: the model reaches for a casing/underscore variant of a
 * real field — `max_results` for `maxResults`, `time_min`/`time_max` for
 * `timeMin`/`timeMax`, `per_page` for `perPage`, `page_token` for `pageToken` —
 * which the `.strict()` schema rejects with `unrecognized_keys`, burning a boss
 * turn and flashing a "Couldn't {integration}" blemish before it self-corrects.
 * These variants differ from the canonical key only in case and `_`/`-`, so one
 * mechanism fixes the whole family across every tool: match a model key to a
 * schema key by its *canonical form* (lower-cased, `_`/`-` stripped) and rename.
 *
 * Direction-agnostic on purpose — the curated schemas are mostly camelCase
 * (`maxResults`, `timeMin`) but GitHub uses snake_case (`pull_number`,
 * `issue_number`) to match the REST API, so the model fumbles in both
 * directions. Canonicalizing both sides handles either.
 *
 * Runs BEFORE `safeParse` on the model's raw input; the schema's own preprocess
 * wrappers (`withQueryAlias`, `withKeyAliases`, `promoteWindowSynonym`, …) then
 * handle genuine *synonyms* (different words), which this does not touch. The
 * accepted-key list comes from the same `z.toJSONSchema(schema, { io: "input" })`
 * the model is shown, so it sees canonical keys even through preprocess wrappers.
 *
 * Collision-safe: a canonical form shared by two accepted keys is ambiguous and
 * left alone, and a rename never clobbers a canonical key the model already set.
 * Pure and dependency-light (zod types only) so it unit-tests in isolation.
 */

const canon = (key: string): string => key.toLowerCase().replace(/[_-]/g, "");

export interface KeyNormalizationResult {
  /** The input with recognizable casing/underscore variants renamed to the schema key. */
  input: unknown;
  /** Each rename applied, for optional telemetry / debugging. */
  renamed: { from: string; to: string }[];
}

export function normalizeToolInputKeys(
  input: unknown,
  schema: z.ZodTypeAny,
): KeyNormalizationResult {
  if (!isRecord(input)) return { input, renamed: [] };
  const accepted = acceptedParamNames(schema);
  if (accepted.length === 0) return { input, renamed: [] };

  const acceptedSet = new Set(accepted);
  // canonical form → the single accepted key it maps to, or null when two
  // accepted keys collapse to the same form (ambiguous — never rename into it).
  const canonToKey = new Map<string, string | null>();
  for (const key of accepted) {
    const c = canon(key);
    canonToKey.set(c, canonToKey.has(c) ? null : key);
  }

  const renamed: { from: string; to: string }[] = [];
  let next = input;
  for (const key of Object.keys(input)) {
    if (acceptedSet.has(key)) continue; // already a canonical key — leave it
    const target = canonToKey.get(canon(key));
    if (!target) continue; // no match, or an ambiguous canonical form
    if (target in next) continue; // canonical key already present — don't clobber
    if (next === input) next = { ...input };
    next[target] = next[key];
    delete next[key];
    renamed.push({ from: key, to: target });
  }
  return { input: next, renamed };
}
