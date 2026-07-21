import { boundToolResult } from "./bound";
import { isPlainRecord } from "./guards";
import type { PassthroughTruncation } from "./passthrough";
import { sanitizeToolResult } from "./sanitize";

/**
 * Payload bounding for untrusted, uncurated tool-result bodies bound for the
 * transcript — shared by the general read-only passthrough tier (ADR-0074
 * rung-a) and the raw MCP client (epic #271). It lives in `@alfred/contracts`,
 * not beside either consumer, because both call sites do the *same* job — bound
 * an untrusted provider payload for model exposure — and the primitives it
 * composes ({@link sanitizeToolResult}, {@link boundToolResult}) already live
 * here. Keeping the composition wrapper below its consumers avoids a stable
 * primitive depending up on a volatile product tier.
 *
 * The pipeline composes four bounds:
 *   1. `sanitizeToolResult` — strip NUL/lone-surrogate poison (ADR-0070).
 *   2. `boundToolResult` — cap any single string at 8,000 chars.
 *   3. every array at any depth is capped to its first {@link PASSTHROUGH_MAX_ARRAY_ITEMS}
 *      elements — a top-level-only row cap is insufficient because provider
 *      payloads nest their lists (`items`, `data`, `messages`, `value`, …).
 *   4. the whole body is capped to {@link PASSTHROUGH_MAX_BODY_BYTES} via
 *      deterministic structural pruning that always leaves valid JSON.
 *
 * Whenever anything is clipped, a {@link PassthroughTruncation} "thermometer"
 * signal is emitted so we can *measure* the context wall being hit (ADR-0074).
 *
 * Web-safe (pure `TextEncoder`/`JSON`/structural work, no Node APIs), matching
 * the repo invariant that cross-boundary browser-safe contracts live here.
 */

/** Every array at any depth is capped to its first N elements. */
export const PASSTHROUGH_MAX_ARRAY_ITEMS = 50;

/** The complete returned body is capped to this many bytes (32 KiB). */
export const PASSTHROUGH_MAX_BODY_BYTES = 32 * 1024;

const encoder = new TextEncoder();

/** Approximate serialized byte size of a JSON-shaped value. */
function approxBytes(value: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "";
  } catch {
    return 0;
  }
  return encoder.encode(json).length;
}

interface ArrayCapResult {
  value: unknown;
  /** Total array elements dropped across every array at every depth. */
  dropped: number;
}

/**
 * Recursively cap every array to its first {@link PASSTHROUGH_MAX_ARRAY_ITEMS}
 * elements. Returns a new structure only when something changed (clean path
 * allocates nothing). Exotic objects pass through — mirrors the sanitize/bound
 * POJO posture.
 */
function capArrays(value: unknown): ArrayCapResult {
  if (Array.isArray(value)) {
    let dropped = 0;
    let changed = false;
    const kept = value.slice(0, PASSTHROUGH_MAX_ARRAY_ITEMS);
    if (value.length > PASSTHROUGH_MAX_ARRAY_ITEMS) {
      dropped += value.length - PASSTHROUGH_MAX_ARRAY_ITEMS;
      changed = true;
    }
    const out = kept.map((item) => {
      const r = capArrays(item);
      dropped += r.dropped;
      if (r.value !== item) changed = true;
      return r.value;
    });
    return { value: changed ? out : value, dropped };
  }
  if (isPlainRecord(value)) {
    let dropped = 0;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const r = capArrays(v);
      dropped += r.dropped;
      if (r.value !== v) changed = true;
      out[key] = r.value;
    }
    return { value: changed ? out : value, dropped };
  }
  return { value, dropped: 0 };
}

/**
 * Deterministically prune a value so its serialized size fits `budget` bytes,
 * always leaving valid JSON. Greedy in stable order: keep leading array
 * elements / object entries while they fit, recurse into a container child that
 * would overflow, and drop the rest behind an explicit truncation sentinel so
 * the model reads the result as clipped, never complete. Primitives (already
 * string-capped upstream) are returned as-is.
 */
function pruneToBudget(value: unknown, budget: number): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    // Reserve room for the closing "]" and a possible sentinel element.
    let used = 2;
    for (let i = 0; i < value.length; i++) {
      const remaining = budget - used;
      const child = fitChild(value[i], remaining);
      if (child === OVERFLOW) {
        out.push(
          `…[${value.length - i} of ${value.length} items dropped to fit ${budget}-byte cap]`,
        );
        break;
      }
      out.push(child);
      used += approxBytes(child) + 1; // +1 for the comma
    }
    return out;
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    let used = 2;
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const [key, v] = entry;
      const remaining = budget - used;
      const child = fitChild(v, remaining - approxBytes(key) - 4); // key + quotes + colon
      if (child === OVERFLOW) {
        out.__truncated__ = `${entries.length - i} of ${entries.length} fields dropped to fit ${budget}-byte cap`;
        break;
      }
      out[key] = child;
      used += approxBytes(key) + approxBytes(child) + 4;
    }
    return out;
  }
  // A lone primitive that still overflows the whole budget — only possible for a
  // very long multibyte string (post 8k-char cap). Replace with a marker.
  return `…[value dropped to fit ${budget}-byte cap]`;
}

const OVERFLOW = Symbol("overflow");

/**
 * Fit one child into `remaining` bytes: keep it whole if it fits, recurse into a
 * container that doesn't, or signal OVERFLOW for a scalar/too-small budget so
 * the parent stops and appends its sentinel.
 */
function fitChild(child: unknown, remaining: number): unknown | typeof OVERFLOW {
  if (remaining <= 0) return OVERFLOW;
  if (approxBytes(child) <= remaining) return child;
  if (Array.isArray(child) || isPlainRecord(child)) {
    return pruneToBudget(child, remaining);
  }
  return OVERFLOW;
}

interface ByteCapResult {
  value: unknown;
  /** Approximate bytes dropped (original minus returned). */
  dropped: number;
}

function capBytes(value: unknown, budget: number): ByteCapResult {
  const before = approxBytes(value);
  if (before <= budget) return { value, dropped: 0 };
  const pruned = pruneToBudget(value, budget);
  const after = approxBytes(pruned);
  return { value: pruned, dropped: Math.max(0, before - after) };
}

export interface BoundedPassthroughBody {
  value: unknown;
  truncation?: PassthroughTruncation;
}

/**
 * Bound a raw provider body for the transcript: compose poison-strip, per-string
 * cap, array-item cap, and total-byte cap, emitting a {@link PassthroughTruncation}
 * signal listing every cause that fired. Idempotent with the dispatch-boundary
 * sanitize pass (safe to run both).
 */
export function boundPassthroughBody(input: unknown): BoundedPassthroughBody {
  const originalBytesApprox = approxBytes(input);
  const causes: PassthroughTruncation["causes"] = [];

  const sanitized = sanitizeToolResult(input).value;

  const stringBounded = boundToolResult(sanitized);
  if (stringBounded.clipped > 0) {
    causes.push({ kind: "string_chars", droppedApprox: stringBounded.clipped });
  }

  const arrayCapped = capArrays(stringBounded.value);
  if (arrayCapped.dropped > 0) {
    causes.push({ kind: "array_items", droppedApprox: arrayCapped.dropped });
  }

  const byteCapped = capBytes(arrayCapped.value, PASSTHROUGH_MAX_BODY_BYTES);
  if (byteCapped.dropped > 0) {
    causes.push({ kind: "body_bytes", droppedApprox: byteCapped.dropped });
  }

  if (causes.length === 0) {
    return { value: byteCapped.value };
  }
  return {
    value: byteCapped.value,
    truncation: {
      handleEligible: true,
      originalBytesApprox,
      returnedBytes: approxBytes(byteCapped.value),
      causes,
    },
  };
}
