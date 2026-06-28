/**
 * Persistence poison-resistance (ADR-0070).
 *
 * Postgres rejects `U+0000` (the NUL byte) in both `text` and `jsonb` columns
 * — `22021 invalid byte sequence for encoding "UTF8": 0x00` for text and
 * `22P05 unsupported Unicode escape sequence` for jsonb. Lone UTF-16
 * surrogates (a high or low surrogate with no pair) are the same class of
 * un-encodable garbage. A tool that decodes binary as text (e.g.
 * `drive.export_file` running a 43KB PDF through `res.text()`) returns a string
 * carrying these bytes; persisting it throws *outside* the dispatcher's
 * try/catch and wedges the run (see ADR-0070's "Why").
 *
 * {@link sanitizeToolResult} is the platform invariant: every tool result is
 * walked and stripped the instant `tool.execute` returns, before it can reach
 * any persisted sink (`execute_result` jsonb, the in-memory transcript, the
 * returned `toolResult`). It is also applied at the error-recording sinks to
 * close the throw-poison class — a tool that *throws* a NUL-byte message —
 * which the result-boundary walk structurally cannot reach.
 *
 * Web-safe (pure string/structural work, no Node APIs) so it can live in
 * `@alfred/contracts` as the one definition shared by server and any future
 * client use.
 */

// U+0000, plus lone surrogates: a high surrogate (D800–DBFF) not followed by a
// low surrogate, or a low surrogate (DC00–DFFF) not preceded by a high one.
// Well-formed surrogate *pairs* (real astral characters, e.g. emoji) are left
// intact — only unpaired halves are stripped.
// oxlint-disable-next-line no-control-regex -- matching U+0000 is the purpose of this sanitizer
const POISON_RE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Strip poison code units from a single string, reporting how many were removed. */
function stripString(s: string): { value: string; removed: number } {
  let removed = 0;
  const value = s.replace(POISON_RE, () => {
    removed += 1;
    return "";
  });
  return { value, removed };
}

/** The result of a sanitize pass. */
export interface SanitizeResult {
  value: unknown;
  /** Total poison code units stripped across all strings and keys. */
  removed: number;
  /**
   * Number of object keys that, *after* stripping, collided with another key
   * in the same object. Stripping a NUL byte can map two distinct keys to the
   * same name (`{"ab":1,"a\0b":2}` → both want `ab`); rather than silently
   * overwrite, the colliding entries are preserved under a disambiguated key
   * (`ab�1`) and counted here so the caller can warn loudly.
   */
  collisions: number;
}

/**
 * Recursively strip `U+0000` and lone surrogates from every string in a value
 * — including **object keys** (a NUL-byte key poisons the same jsonb write) —
 * returning the cleaned value, the total code units removed, and the number of
 * key collisions stripping induced.
 *
 * Non-string scalars (number/boolean/null/undefined) pass through untouched.
 * The returned value is a *new* structure when anything changed; when nothing
 * was poisoned the input is returned as-is (so the common clean path allocates
 * nothing). The `sanitized` flag the caller derives from this must ride on the
 * dispatch envelope, never be assigned onto the result value (a bare
 * string/array/primitive result can't carry a property, and assigning to a
 * string throws under ES-module strict mode).
 */
export function sanitizeToolResult(value: unknown): SanitizeResult {
  if (typeof value === "string") {
    return { ...stripString(value), collisions: 0 };
  }
  if (Array.isArray(value)) {
    let removed = 0;
    let collisions = 0;
    let changed = false;
    const out = value.map((item) => {
      const r = sanitizeToolResult(item);
      removed += r.removed;
      collisions += r.collisions;
      if (r.value !== item) changed = true;
      return r.value;
    });
    return { value: changed ? out : value, removed, collisions };
  }
  if (value !== null && typeof value === "object") {
    // Skip exotic objects we shouldn't (and can't safely) rebuild — Date,
    // Map/Set, class instances, etc. jsonb persistence only ever sees plain
    // objects/arrays; anything else is serialized by the driver, and rewriting
    // it here would silently flatten it. Tool results are POJO/JSON shaped.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return { value, removed: 0, collisions: 0 };
    }
    let removed = 0;
    let collisions = 0;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const keyResult = stripString(key);
      removed += keyResult.removed;
      const valResult = sanitizeToolResult(v);
      removed += valResult.removed;
      collisions += valResult.collisions;
      if (keyResult.removed > 0 || valResult.value !== v) changed = true;

      // Stripping the key can collide with a key already written (or a clean
      // key elsewhere in the object). Preserve both rather than silently drop:
      // keep the existing entry and write this one under a unique disambiguated
      // key. (Reachable only with NUL-byte keys, i.e. binary-ish garbage.)
      let outKey = keyResult.value;
      if (Object.prototype.hasOwnProperty.call(out, outKey)) {
        collisions += 1;
        changed = true;
        let suffix = 1;
        let candidate = `${keyResult.value}�${suffix}`;
        while (Object.prototype.hasOwnProperty.call(out, candidate)) {
          suffix += 1;
          candidate = `${keyResult.value}�${suffix}`;
        }
        outKey = candidate;
      }
      out[outKey] = valResult.value;
    }
    return { value: changed ? out : value, removed, collisions };
  }
  return { value, removed: 0, collisions: 0 };
}

/**
 * Convenience wrapper for the error-recording sinks (ADR-0070 §1.3): strip
 * poison from a plain string, discarding the count. Used where the value is
 * known to be a message/text string and no flag is needed
 * (`commitStepFailure`, `markRunFailed`, `finalizeFailedMessage` content).
 */
export function sanitizeErrorMessage(message: string): string {
  return stripString(message).value;
}
