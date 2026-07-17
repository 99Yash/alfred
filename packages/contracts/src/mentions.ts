import { INTEGRATION_SLUGS, isIntegrationSlug, type IntegrationSlug } from "./tools";

const MENTION_RE = /(?:^|[^a-z0-9_-])@([a-z][a-z0-9_]*)/gi;

export function parseIntegrationMentions(
  brief: string,
  allowedIntegrations: readonly string[],
): IntegrationSlug[] {
  const allowed =
    allowedIntegrations.length > 0
      ? new Set<string>(allowedIntegrations)
      : new Set<string>(INTEGRATION_SLUGS);
  const seen = new Set<IntegrationSlug>();

  for (const match of brief.matchAll(MENTION_RE)) {
    const slug = match[1]?.toLowerCase() ?? "";
    if (!isIntegrationSlug(slug)) continue;
    if (slug === "system") continue;
    if (!allowed.has(slug)) continue;
    seen.add(slug);
  }

  return [...seen];
}
