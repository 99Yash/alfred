/**
 * Per-route `<head>` tags. The router merges every match's meta and the deepest wins,
 * so the root sets defaults. Static tags stay in `index.html`.
 */

const SITE_NAME = "Alfred";

const SITE_TAGLINE = "The Co-worker that never sleeps.";

const SITE_DESCRIPTION =
  "Alfred is a personal assistant wired into your email, calendar, and the tools you already use. One place to get real work done.";

const SITE_URL = "https://alfred.beauty";

/** 1200x630. OG scrapers need an absolute URL. */
const SOCIAL_IMAGE = `${SITE_URL}/images/og-card.png`;

export interface PageMetaInput {
  /** `"Settings"` becomes `"Settings · Alfred"`. */
  title?: string | undefined;
  description?: string | undefined;
  /** Canonical path. Omit only for the root defaults. */
  path?: string | undefined;
  /** For a URL that is a secret, such as a shared thread slug (ADR-0102). No canonical link. */
  noindex?: boolean | undefined;
}

interface MetaTag {
  title?: string | undefined;
  name?: string | undefined;
  property?: string | undefined;
  content?: string | undefined;
}

interface LinkTag {
  rel: string;
  href: string;
}

/** Exported so a route can set `document.title` from live data. */
export function formatPageTitle(title?: string): string {
  return title ? `${title} · ${SITE_NAME}` : `${SITE_NAME} · ${SITE_TAGLINE}`;
}

function absoluteUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;

  return normalized === "/" ? SITE_URL : `${SITE_URL}${normalized}`;
}

/** Use in a route's `head`: `head: () => pageMeta({ title: "Settings", path: "/settings" })`. */
interface PageMeta {
  meta: MetaTag[];
  links: LinkTag[];
}

export function pageMeta({ title, description, path, noindex }: PageMetaInput = {}): PageMeta {
  const fullTitle = formatPageTitle(title);
  const desc = description ?? SITE_DESCRIPTION;
  // A canonical link would invite indexing.
  const url = path && !noindex ? absoluteUrl(path) : null;

  return {
    meta: [
      { title: fullTitle },
      { name: "description", content: desc },
      ...(noindex ? [{ name: "robots", content: "noindex, nofollow" }] : []),
      { property: "og:title", content: fullTitle },
      { property: "og:description", content: desc },
      ...(url ? [{ property: "og:url", content: url }] : []),
      { name: "twitter:title", content: fullTitle },
      { name: "twitter:description", content: desc },
    ],
    links: url ? [{ rel: "canonical", href: url }] : [],
  };
}

/** Root defaults: `pageMeta` plus the shared social-card tags. */
export function siteMeta(): PageMeta {
  const base = pageMeta();

  return {
    meta: [
      ...base.meta,
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:type", content: "website" },
      { property: "og:image", content: SOCIAL_IMAGE },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: `${SITE_NAME} — ${SITE_TAGLINE}` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: SOCIAL_IMAGE },
    ],
    links: [],
  };
}
