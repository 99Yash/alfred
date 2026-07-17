/**
 * Favicon + domain helpers, shared across every surface that shows a source
 * logo (chat citations, the inbox feed, the landing-page chat showcase). These
 * lived as three drifting copies with "keep aligned" comments — this is the one
 * source of truth now.
 */

/** Bare hostname for display + favicon lookup, resilient to malformed hrefs. */
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

/**
 * DuckDuckGo's favicon CDN (cookieless, returns a transparent fallback rather
 * than 404ing for unknown domains, so it never spams the console) — chosen over
 * Google's `s2/favicons` gstatic endpoint, which does 404. Accepts a bare
 * domain; pair with {@link domainOf} when you only have a full URL.
 */
export function faviconFor(domain: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}
