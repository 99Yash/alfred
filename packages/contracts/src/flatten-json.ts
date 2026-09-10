import { isRecord } from "./guards";

/**
 * Bounded scalar leaves from an untrusted JSON value. Paths preserve context
 * for text indexing and let callers inspect link fields without a second walk.
 * Truncated leaves must not be used as links or other exact scalar values.
 * Limits bound recursion, wide empty containers, and text sent to an embedder.
 */
export function flattenJson(value: unknown) {
  const leaves: { path: string[]; value: string; truncated: boolean }[] = [];
  let remaining = 48_000;
  let visited = 0;

  function visit(node: unknown, path: string[]): void {
    if (++visited > 4096 || remaining <= 0 || path.length > 16) return;

    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      const labelLength = path.join(".").length + 3;

      if (labelLength >= remaining) return;
      const scalar = String(node);
      const text = scalar.slice(0, remaining - labelLength);

      if (!text) return;
      remaining -= text.length + labelLength;
      leaves.push({ path, value: text, truncated: text.length < scalar.length });
    } else if (Array.isArray(node) || isRecord(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (visited >= 4096 || remaining <= 0) break;
        visit(child, [...path, key]);
      }
    }
  }

  visit(value, []);

  return leaves;
}
