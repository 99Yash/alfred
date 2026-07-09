import { archetypes, type Archetype } from "./archetypes";
import { accent, font, palette } from "./tokens";

/**
 * The Alfred house theme (pristine-artifacts Phase 1). One theme ships in v1;
 * breadth (more themes, more archetypes) is deferred to Phase 5. The theme is a
 * thin, typed description over the token source of truth plus the archetype set
 * — the prompt and any future theme picker read from here rather than
 * re-describing the look in prose.
 */
export interface ArtifactTheme {
  readonly id: string;
  readonly name: string;
  /** One-line character of the theme, used in guidance. */
  readonly voice: string;
  readonly font: string;
  readonly ink: string;
  readonly surface: string;
  readonly accent: string;
  readonly archetypes: readonly Archetype[];
}

/**
 * "Alfred Light" — the app's own light grammar: brand ink on white, generous
 * whitespace, one saturated purple accent, quiet hairline surfaces, and the
 * self-hosted Open Runde face. Calm and editorial, not loud.
 */
export const houseTheme: ArtifactTheme = {
  id: "alfred-light",
  name: "Alfred Light",
  voice:
    "Calm, editorial, and confident: brand ink on white, generous whitespace, one purple accent used sparingly for emphasis.",
  font: font.family,
  ink: palette.ink,
  surface: palette.surface,
  accent: accent.from,
  archetypes,
};
