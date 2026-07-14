import { z } from "zod";

/**
 * Tool input schemas are pure zod and almost always `.strict()`, so when a
 * model guesses a parameter name that doesn't exist it gets a bare
 * `Unrecognized key: "x"` back — which says what's *wrong* but never what's
 * *right*, leaving the model to blindly re-guess. (Observed in a real trace: a
 * `calendar.list_events` call invented `timeframe`, was rejected, then bailed
 * to explicit RFC3339 bounds instead of the `window` enum it already had —
 * burning two turns on a "what's on my calendar today" question.) Enrich the
 * `unrecognized_keys` message with the parameters the schema actually accepts so
 * the next turn can self-correct. Best-effort and structural (no prompt patch);
 * it never throws and leaves every other validation message untouched.
 *
 * Kept dependency-free (zod only) so it can be unit-tested without dragging in
 * the dispatcher's db/queue imports.
 */
// Tool input schemas are static module constants, so their accepted-key set is
// invariant. `normalizeToolInputKeys` now calls this on the happy path of every
// dispatch, so memoize per schema identity — `z.toJSONSchema` walks the whole
// schema (every `.describe`, refine, wrapper) and that work is pure waste to
// repeat. WeakMap keyed on the schema object so a schema that's ever GC'd
// doesn't pin its cache entry.
const acceptedParamCache = new WeakMap<z.ZodTypeAny, readonly string[]>();

export function acceptedParamNames(schema: z.ZodTypeAny): readonly string[] {
  const cached = acceptedParamCache.get(schema);
  if (cached) return cached;
  let names: readonly string[];
  try {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties?: Record<string, unknown>;
    };
    names = json.properties ? Object.freeze(Object.keys(json.properties)) : EMPTY;
  } catch {
    names = EMPTY;
  }
  acceptedParamCache.set(schema, names);
  return names;
}

const EMPTY: readonly string[] = Object.freeze([]);

export function enrichInvalidInputMessage(
  baseMessage: string,
  schema: z.ZodTypeAny,
  issues: readonly { code?: string }[],
): string {
  if (!issues.some((issue) => issue.code === "unrecognized_keys")) return baseMessage;
  const accepted = acceptedParamNames(schema);
  if (accepted.length === 0) return baseMessage;
  return `${baseMessage}\nThis tool accepts only these parameters: ${accepted.join(", ")}.`;
}
