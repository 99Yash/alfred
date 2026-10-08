import { archetypes, type Archetype } from "./archetypes";
import { accent, font, palette } from "./tokens";

/** A theme described from the tokens and archetypes. Only one theme exists. */
export interface ArtifactTheme {
  readonly id: string;
  readonly name: string;
  /** One line of character for the prompt. */
  readonly voice: string;
  readonly font: string;
  readonly ink: string;
  readonly surface: string;
  readonly accent: string;
  readonly archetypes: readonly Archetype[];
}

/** The house theme. */
export const houseTheme: ArtifactTheme = {
  id: "alfred-light",
  name: "Alfred Light",
  voice:
    "Calm, editorial, and confident: brand ink on a clean surface, generous whitespace, one purple accent used sparingly for emphasis.",
  font: font.family,
  ink: palette.ink,
  surface: palette.surface,
  accent: accent.from,
  archetypes,
};
