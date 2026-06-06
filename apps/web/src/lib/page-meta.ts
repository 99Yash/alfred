/**
 * Per-route `<head>` metadata for TanStack Router.
 *
 * Routes declare a `head` option that returns `{ meta }`; the root renders a
 * single `<HeadContent />` (see `routes/__root.tsx`) and the router merges the
 * meta arrays from every matched route, deduping by `name`/`property` with the
 * deepest match winning. So the root supplies site-wide defaults and each page
 * overrides its title, description, and route-specific URL tags.
 *
 * Static document tags (charset, viewport, icons, manifest, theme-color) stay
 * in `index.html` — they never change between routes, so there's no reason to
 * pay to re-render them client-side.
 */

const SITE_NAME = "Alfred";
const SITE_TAGLINE = "The AI coworker that never sleeps.";

export const SITE_DESCRIPTION =
  "Alfred is a personal AI assistant wired into your email, calendar, and the tools you already use. One place to get real work done.";

/** Production origin, used to build absolute OG/canonical URLs. */
const SITE_URL = "https://alfred.beauty";

/**
 * Absolute OG/Twitter card image. OG scrapers require an absolute URL.
 * TODO: swap for a dedicated 1200x630 card once the artwork lands.
 */
const SOCIAL_IMAGE = `${SITE_URL}/images/logo/icon-512.png`;

export interface PageMetaInput {
  /** Page-specific title segment, e.g. `"Settings"` → `"Settings · Alfred"`. */
  title?: string;
  /** Page-specific description; falls back to the site default. */
  description?: string;
  /** Canonical route path, e.g. `"/settings"`. Omit only for route-agnostic defaults. */
  path?: string;
}

interface MetaTag {
  title?: string;
  name?: string;
  property?: string;
  content?: string;
}

interface LinkTag {
  rel: string;
  href: string;
}

/**
 * Build the full document title for a page-specific segment:
 * `"Settings"` → `"Settings · Alfred"`, or the site default when omitted.
 * Exported so routes can mirror reactive titles into `document.title`
 * (e.g. a chat tab tracking its derived thread title).
 */
export function formatPageTitle(title?: string): string {
  return title ? `${title} · ${SITE_NAME}` : `${SITE_NAME} · ${SITE_TAGLINE}`;
}

function absoluteUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized === "/" ? SITE_URL : `${SITE_URL}${normalized}`;
}

/**
 * Title + description (plus their OG/Twitter mirrors) for a single page. Use
 * inside a route's `head` option:
 *
 *   export const Route = createFileRoute("/settings")({
 *     head: () => pageMeta({ title: "Settings", path: "/settings" }),
 *     component: SettingsRoute,
 *   });
 */
export function pageMeta({ title, description, path }: PageMetaInput = {}): {
  meta: MetaTag[];
  links: LinkTag[];
} {
  const fullTitle = formatPageTitle(title);
  const desc = description ?? SITE_DESCRIPTION;
  const url = path ? absoluteUrl(path) : null;
  return {
    meta: [
      { title: fullTitle },
      { name: "description", content: desc },
      { property: "og:title", content: fullTitle },
      { property: "og:description", content: desc },
      ...(url ? [{ property: "og:url", content: url }] : []),
      { name: "twitter:title", content: fullTitle },
      { name: "twitter:description", content: desc },
    ],
    links: url ? [{ rel: "canonical", href: url }] : [],
  };
}

/**
 * Site-wide defaults for the root route — the page-level tags from `pageMeta`
 * plus the static social-card scaffolding that every page shares.
 */
export function siteMeta(): { meta: MetaTag[]; links: LinkTag[] } {
  const base = pageMeta();
  return {
    meta: [
      ...base.meta,
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:type", content: "website" },
      { property: "og:image", content: SOCIAL_IMAGE },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: SOCIAL_IMAGE },
    ],
    links: [],
  };
}
