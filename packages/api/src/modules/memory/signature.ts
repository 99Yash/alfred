import { createHash } from "node:crypto";

/**
 * Stable hash for `(key, value)` pairs we record in `rejected_inferences`.
 *
 * Drives "did the user already say no to (key='manager', value='Bob')?"
 * — so it must be deterministic across re-extractions. Object keys are
 * sorted recursively before hashing; strings are NFKC + lower-cased so
 * cosmetic variants ("alice@oliv.ai" vs "Alice@Oliv.ai") collide.
 */
export function valueSignature(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFKC").toLowerCase());
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(String(value));
}
