import { isRecord } from "./guards";

/**
 * Strip bytes Postgres cannot store (ADR-0070): NUL fails `text` and `jsonb`,
 * and lone surrogates are the same class. A binary file read as text carries them,
 * and the failed write wedges the run. Applied to every tool result and to
 * recorded error messages.
 */

// NUL and unpaired surrogate halves. Valid pairs (emoji) stay.
// oxlint-disable-next-line no-control-regex -- matching U+0000 is the purpose of this sanitizer
const POISON_RE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function stripString(s: string) {
  let removed = 0;

  const value = s.replace(POISON_RE, () => {
    removed += 1;

    return "";
  });

  return { value, removed };
}

export interface SanitizeResult<T = unknown> {
  value: T;
  removed: number;
  /** Keys that collided after stripping (`ab` and `a\0b`). Both are kept, one under a new key. */
  collisions: number;
}

/**
 * Recursively strip poison from every string and object key. Returns the same
 * value when clean. Put the `sanitized` flag on the envelope, not on the value:
 * a string result cannot carry a property.
 */
export function sanitizeToolResult<T>(value: T): SanitizeResult<T> {
  // SAFETY: only string contents and keys change, so the shape holds. This needs
  // `isRecord` to reject Date, Map, and class instances so they pass through.
  return sanitizeUnknown(value) as SanitizeResult<T>;
}

function sanitizeUnknown(value: unknown): SanitizeResult {
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

  if (isRecord(value)) {
    let removed = 0;
    let collisions = 0;
    let changed = false;
    const out: Record<string, unknown> = {};

    for (const [key, v] of Object.entries(value)) {
      const keyResult = stripString(key);
      removed += keyResult.removed;
      const valResult = sanitizeToolResult(v);
      removed += valResult.removed;
      collisions += valResult.collisions;

      if (keyResult.removed > 0 || valResult.value !== v) changed = true;

      // A stripped key can collide with one already written. Keep both.
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
 * Strip poison from a message string (ADR-0070). `max` also caps the length, so
 * the stored and published copies match: an over-cap frame fails to parse and
 * rolls back the terminal write. The cut can split a surrogate pair, so it strips again.
 */
export function sanitizeErrorMessage(message: string, max?: number): string {
  const stripped = stripString(message).value;

  if (max === undefined || stripped.length <= max) return stripped;

  return stripString(stripped.slice(0, max)).value;
}
