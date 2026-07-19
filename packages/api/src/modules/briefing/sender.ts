/**
 * Reduce a raw email `From` header to a human label — the display name if
 * present (`"Ada Lovelace" <ada@x.com>` → `Ada Lovelace`), else the bare
 * address, else the trimmed input. Shared by the gather (data prep) and compose
 * (email render) stages so both shorten senders identically. Lives in its own
 * sender-focused leaf rather than riding along in the reference builder.
 */
export function shortenFrom(from: string | null): string | null {
  if (!from) return null;
  const trimmed = from.trim();
  const angleMatch = trimmed.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (angleMatch) {
    const name = angleMatch[1]?.trim();
    if (name) return name;
    return angleMatch[2] ?? null;
  }
  return trimmed;
}
