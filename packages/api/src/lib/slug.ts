const COMBINING_MARKS = /[̀-ͯ]/g;

/** Convert a display name to the stable URL-safe base used by owned entities. */
export function slugBase(input: string, fallback: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(COMBINING_MARKS, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  );
}

/** Pick the first available `base`, `base-2`, … candidate from a known set. */
export function availableSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;

  for (let n = 2; n < 1_000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
