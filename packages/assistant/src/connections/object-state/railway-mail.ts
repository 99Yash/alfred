import {
  canonicalizeRailwayTargetId,
  emailDomain,
  isDomainOrSubdomain,
  parseEmailAddress,
} from "@alfred/contracts";

/**
 * Reads a Railway notification mail (#1094). The text adapter and the verified pull share this
 * module, so they agree on who Railway is and on what a target URL is.
 */

/** Failure mails come from `notify.railway.app`, so a subdomain also counts. */
const RAILWAY_SENDER_DOMAINS: readonly string[] = ["railway.app", "railway.com"];

export function isRailwaySender(from: string | null | undefined): boolean {
  const domain = emailDomain(parseEmailAddress(from));

  return (
    domain !== null && RAILWAY_SENDER_DOMAINS.some((base) => isDomainOrSubdomain(domain, base))
  );
}

/**
 * The "View build logs" link: `https://railway.com/project/<p>/service/<s>?id=<d>&environmentId=<e>`.
 * The ids are opaque, so they match a segment of anything but `/`, `?`, `&` and white space. The
 * query is read up to the first white space or quote; `;` also splits it, for an `&amp;` body.
 */
const RAILWAY_SERVICE_URL_RE =
  /\bhttps?:\/\/(?:www\.)?railway\.(?:com|app)\/project\/([A-Za-z0-9-]+)\/service\/([A-Za-z0-9-]+)(\?[^\s"'<>)\]]*)?/gi;

const ENVIRONMENT_ID_PARAM_RE = /[?&;]environmentId=([A-Za-z0-9-]+)/;

/**
 * Canonical `deployment_target` ids the text names, deduped in first-seen order. A URL with no
 * `environmentId` names no target. A caller that needs one checks the length.
 */
export function collectRailwayTargetIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(RAILWAY_SERVICE_URL_RE)) {
    const [, projectId, serviceId, query] = match;
    const environmentId = query ? ENVIRONMENT_ID_PARAM_RE.exec(query)?.[1] : undefined;

    if (!projectId || !serviceId || !environmentId) continue;
    const id = canonicalizeRailwayTargetId({ projectId, serviceId, environmentId });

    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}
