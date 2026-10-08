import { z } from "zod";

/**
 * `@`-mention parser for skill prompts and workflow briefs.
 * A bare `@<slug>` resolves at distill time to an integration or skill; else `unresolved`.
 * Explicit forms: `@skill:<slug>` (ADR-0017), `@integration:<slug>`, `@person:<slug>` (not used yet).
 * Needs whitespace or line start before `@`, so `alice@oliv.ai` is not a mention.
 */

export const MENTION_KINDS = ["integration", "skill", "collaborator", "unresolved"] as const;

export type MentionKind = (typeof MENTION_KINDS)[number];

export const parsedMentionSchema = z.object({
  /** Includes the `@`. */
  raw: z.string(),
  kind: z.enum(MENTION_KINDS),
  /** Prefix stripped, lower-cased. */
  slug: z.string(),
  /** Character offset in the source text. */
  index: z.number().int().nonnegative(),
});

export type ParsedMention = z.infer<typeof parsedMentionSchema>;

const MENTION_RE = /(?:^|\s)@(?:(skill|integration|person):)?([a-z0-9][a-z0-9-]{0,63})/gi;

/** Parse mentions; `kind` is the explicit prefix or `unresolved`. Then run {@link resolveMentions}. */
export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = [];

  for (const match of text.matchAll(MENTION_RE)) {
    const [full, prefix, slug] = match;

    if (!slug || match.index === undefined) continue;
    const atOffset = full.indexOf("@");
    const slugLower = slug.toLowerCase();
    // The regex is case-insensitive; compare the lower-cased prefix.
    const prefixLower = prefix?.toLowerCase();
    const raw = `@${prefixLower ? `${prefixLower}:` : ""}${slugLower}`;
    out.push({
      raw,
      kind:
        prefixLower === "skill"
          ? "skill"
          : prefixLower === "integration"
            ? "integration"
            : prefixLower === "person"
              ? "collaborator"
              : "unresolved",
      slug: slugLower,
      index: match.index + atOffset,
    });
  }

  return out;
}

export interface MentionRegistry {
  integrationSlugs: Set<string>;
  skillSlugs: Set<string>;
}

/**
 * Resolve bare mentions. On a collision, integration beats skill: "use this integration"
 * is the common case. Write `@skill:github` to pick the skill.
 */
export function resolveMentions(
  mentions: ParsedMention[],
  registry: MentionRegistry,
): ParsedMention[] {
  return mentions.map((m) => {
    if (m.kind !== "unresolved") return m;

    if (registry.integrationSlugs.has(m.slug)) return { ...m, kind: "integration" };

    if (registry.skillSlugs.has(m.slug)) return { ...m, kind: "skill" };

    return m;
  });
}
