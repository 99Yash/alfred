import { z } from "zod";

/**
 * `@`-mention parser for skill prompts and workflow briefs.
 *
 * Dimension's UX overloads `@` for three reference kinds (integration,
 * skill, collaborator). We follow the same input shape — bare `@<slug>`
 * — and resolve the kind at distill time against the user's registry of
 * connected integrations + authored skills. Unresolved mentions stay in
 * the parsed list as `kind='unresolved'` so the model can flag them in
 * its rationale.
 *
 * Explicit-prefix forms are also accepted for unambiguous authoring:
 *   `@skill:<slug>`        — skill activation per ADR-0017
 *   `@integration:<slug>`  — disambiguate when a slug is shared
 *   `@person:<slug>`       — collaborator (deferred; parsed for forward compat)
 *
 * The regex deliberately rejects mentions inside email addresses
 * (`alice@oliv.ai`) by requiring whitespace / start-of-line before `@`.
 */

export const MENTION_KINDS = ["integration", "skill", "collaborator", "unresolved"] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export const parsedMentionSchema = z.object({
  /** Raw matched text including the `@`. */
  raw: z.string(),
  /** Resolved-or-pending kind. */
  kind: z.enum(MENTION_KINDS),
  /** The slug after stripping the prefix. Lower-cased. */
  slug: z.string(),
  /** Character offset in the source text — handy for inline highlighting later. */
  index: z.number().int().nonnegative(),
});
export type ParsedMention = z.infer<typeof parsedMentionSchema>;

const MENTION_RE = /(?:^|\s)@(?:(skill|integration|person):)?([a-z0-9][a-z0-9-]{0,63})/gi;

/**
 * Parse mentions out of free text. Returns mentions with `kind` set to
 * either the explicit prefix or `'unresolved'`. Run {@link resolveMentions}
 * afterwards to disambiguate bare mentions.
 */
export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const [full, prefix, slug] = match;
    if (!slug || match.index === undefined) continue;
    const atOffset = full.indexOf("@");
    const slugLower = slug.toLowerCase();
    const raw = `@${prefix ? `${prefix.toLowerCase()}:` : ""}${slugLower}`;
    out.push({
      raw,
      kind:
        prefix === "skill"
          ? "skill"
          : prefix === "integration"
            ? "integration"
            : prefix === "person"
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
 * Disambiguate bare `@<slug>` mentions against the user's registry.
 * Precedence on collision (rare at single-user scale):
 *   integration > skill > unresolved
 *
 * A user authoring a skill named "github" while also having Github
 * connected is the conflict case. Integration wins because the more
 * common authoring path is "use this connected integration in this
 * skill" rather than "compose this skill into another." Authors who
 * want skill-precedence write `@skill:github` explicitly.
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
