/** `"Ada Lovelace" <ada@x.com>` becomes `Ada Lovelace`; else the address; else the trimmed input. */
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
