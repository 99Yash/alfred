/** Bare hostname. Survives a malformed href. */
export function domainOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return (
      href
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0] ?? href
    );
  }
}

/** DuckDuckGo, not Google: it returns a blank icon for an unknown domain instead of a 404. */
export function faviconFor(domain: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}
