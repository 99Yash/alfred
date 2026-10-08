import { boundToolResult } from "./bound";
import { isRecord } from "./guards";
import type { PassthroughTruncation } from "./passthrough";
import { sanitizeToolResult } from "./sanitize";

/**
 * Bound an untrusted provider body before the model sees it (ADR-0074).
 * Steps: strip NUL and lone surrogates, cap each string at 8,000 chars,
 * cap every array at any depth (providers nest lists), then cap total bytes.
 */

export const PASSTHROUGH_MAX_ARRAY_ITEMS = 50;

export const PASSTHROUGH_MAX_BODY_BYTES = 32 * 1024;

const encoder = new TextEncoder();

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
  dropped: number;
}

/** Returns the same object when nothing changed. */
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

  if (isRecord(value)) {
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
 * Keep leading entries while they fit, recurse into an overflowing container,
 * and end with a truncation marker so the model sees the result is clipped.
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

  if (isRecord(value)) {
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

  // Only a long multibyte string gets here after the 8k-char cap.
  return `…[value dropped to fit ${budget}-byte cap]`;
}

const OVERFLOW = Symbol("overflow");

/** OVERFLOW tells the parent to stop and append its marker. */
function fitChild(child: unknown, remaining: number): unknown | typeof OVERFLOW {
  if (remaining <= 0) return OVERFLOW;

  if (approxBytes(child) <= remaining) return child;

  if (Array.isArray(child) || isRecord(child)) {
    return pruneToBudget(child, remaining);
  }

  return OVERFLOW;
}

interface ByteCapResult {
  value: unknown;
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

/** Safe to run with the dispatch-boundary sanitize pass too. */
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
