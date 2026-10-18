import { isRecord } from "@alfred/contracts";
import { sha256Hex } from "@alfred/db/hash";

/**
 * Stable hash of `(key, value)` for `rejected_inferences`. Keys sort recursively;
 * strings are NFKC and lowercased, so "Alice@Oliv.ai" matches "alice@oliv.ai".
 */
export function valueSignature(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the hash input dispatches on the runtime type of an unknown value; stored hashes depend on this exact branch.
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFKC").toLowerCase());
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the hash input dispatches on the runtime type of an unknown value; stored hashes depend on this exact branch.
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`);

    return `{${parts.join(",")}}`;
  }

  return JSON.stringify(String(value));
}
