/** A random id: `crypto.randomUUID()`, or `<fallbackPrefix>_<time>_<random>` outside a secure context. */
export function safeRandomId(fallbackPrefix: string): string {
  // lib.dom types `randomUUID` as always present; browsers expose it only in secure contexts.
  if (typeof crypto === "undefined" || !("randomUUID" in crypto))
    return `${fallbackPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return crypto.randomUUID();
}
