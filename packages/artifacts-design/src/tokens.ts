import type { ArtifactFormat } from "@alfred/contracts";

/**
 * The single, typed source of truth for the Alfred artifact design system
 * (pristine-artifacts Phase 1). Every downstream string — the render-time
 * `buildArtifactDocument` shell, the authoring `ARTIFACT_DESIGN_PROMPT`, and the
 * archetype exemplars — derives from the values here so the palette, type
 * ramp, and page geometry can never drift apart (the failure mode called out
 * in the plan: a font list that disagreed across shell + prompt + docstring).
 *
 * Values are the app's own light "app-*" grammar (see `apps/web/src/index.css`),
 * NOT copied from any external deck system: brand ink `#181925`, the neutral
 * surface ramp, the brand purple gradient, and a small set of hue accents. This
 * module is pure data — no DOM, no Node — so it stays importable from both
 * `apps/web` and `packages/api` without tripping `check:web-boundaries`.
 */

/** A CSS custom-property name (without the leading `--`) paired with its value. */
export interface DesignToken {
  readonly name: string;
  readonly value: string;
}

/**
 * Ink + neutral surfaces. `ink` is the brand foreground (`--app-fg-4`, never
 * pure black); the `fg*` stops step down to muted captions; `surface*` climb
 * from page white to the deepest panel fill.
 *
 * The neutrals carry a faint COOL tint (a whisper of the ink's own blue) rather
 * than being dead grey — so a card reads as a tinted material lit from above,
 * not a flat grey box, and the whole page shares one temperature. The tint is
 * deliberately subtle (a few points of blue in the last channel); at a glance it
 * still reads neutral. Text stops are pulled slightly darker than a pure `#666`
 * ramp for crisper contrast on white (the craft floor: muted must still be
 * comfortably legible, not washed out).
 */
export const palette = {
  /** Brand ink — primary text. Mirrors `--app-fg-4`. */
  ink: "#181925",
  /** Body / secondary text. */
  fgMuted: "#585966",
  /** Captions, eyebrows, metadata. */
  fgSubtle: "#8a8b97",
  /** Hairlines, disabled, faintest text. */
  fgFaint: "#adaeba",

  /** Page background. */
  surface: "#ffffff",
  /** Raised panel / card fill (faintly cool). */
  surfaceRaised: "#f6f6f9",
  /** Deeper panel fill. */
  surfaceSunken: "#f0f0f4",
  /** Deepest fill / rule. */
  surfaceDeep: "#e7e7ee",
  /**
   * The lit TOP edge of a raised surface (the lighter stop of a card/chip
   * gradient). Pure white in light so a card reads lit-from-above; a distinct
   * token so dark mode can substitute a lifted charcoal instead of a white
   * blowout. Never used as a fill on its own — only as the top of a gradient.
   */
  surfaceHi: "#ffffff",

  /** Hairline border. */
  border: "#e5e5ec",
  /** Stronger divider. */
  borderStrong: "#cfcfda",
} as const;

/**
 * The DARK counterpart of `palette` — a pristine, cool-tinted near-black rather
 * than dead grey or pure black, so surfaces can layer with real depth (the app
 * itself is dark-first, `#0a0a0a`; artifacts sit a hair above the void so a deck
 * reads as a deliberate sheet, not a hole). In dark mode the surface ramp
 * INVERTS its role: a raised card is LIGHTER than the page and a recessed panel
 * is DARKER, the opposite of light mode, which is how depth reads against a dark
 * ground. Emitted as a `:root[data-theme="dark"]` override by the shell, so the
 * whole system flips by flipping one attribute — no restored bytes, retroactive
 * across every existing artifact. Text stops keep a comfortable contrast floor
 * on the darkest surface (muted stays ~7:1, captions ~4.5:1).
 */
export const darkPalette = {
  /** Primary text — near-white with a faint cool cast, never pure #fff. */
  ink: "#f4f5fb",
  /** Body / secondary text. */
  fgMuted: "#a8aab8",
  /** Captions, eyebrows, metadata. */
  fgSubtle: "#7d7e8d",
  /** Hairlines, disabled, faintest text. */
  fgFaint: "#54555f",

  /** Page background — deep cool charcoal, a step above the app's `#0a0a0a`. */
  surface: "#0d0d12",
  /** Raised card fill — LIFTED above the page so it reads as a real material. */
  surfaceRaised: "#1a1a23",
  /** Recessed panel fill — carved BELOW the page. */
  surfaceSunken: "#08080c",
  /** Deepest fill. */
  surfaceDeep: "#050508",
  /** The lit top edge of a raised surface (lighter than `surfaceRaised`). */
  surfaceHi: "#23232f",

  /** Hairline border. */
  border: "#282832",
  /** Stronger divider. */
  borderStrong: "#3a3a45",
} as const;

/**
 * The brand accent — the one saturated purple used for emphasis, CTAs, chart
 * fills, and active marks. A vertical gradient from `from` -> `to`, matching
 * `--app-cta-bg`. On-accent text uses `to` (the darker stop), which clears
 * contrast on the accent-soft fill in both schemes.
 */
export const accent = {
  from: "#6b62f2",
  to: "#4f37cb",
  /** Faint accent tint for wash backgrounds / selected rows. */
  soft: "#f1f1fe",
} as const;

/**
 * The DARK accent — the same purple, brightened so it stays luminous against a
 * near-black ground (a mid purple that reads as emphasis on white goes muddy on
 * charcoal). `soft` becomes a deep accent-tinted charcoal (badge/wash fill) in
 * place of the pale light tint, and stays dark enough that on-accent bold text
 * (`to`) still clears a legible contrast.
 */
export const darkAccent = {
  from: "#8f87ff",
  to: "#7a69f4",
  /** Deep accent-tinted charcoal for wash backgrounds / badge fills. */
  soft: "#1d1936",
} as const;

/**
 * Categorical hue accents for charts, badges, and status dots — the vivid `-4`
 * stops from the app light hue scale. Tuned for marks/fills on white, not for
 * body text. Keep the set small; breadth is deferred to Phase 5.
 */
export const hues = {
  blue: "#00c4ff",
  green: "#33c758",
  amber: "#ffa600",
  red: "#ff2f00",
  purple: "#918df6",
  sky: "#2c78fc",
  pink: "#d6409f",
  orange: "#f76808",
} as const;

/**
 * Self-hosted Open Runde (the app's only shipped face — see the `@font-face`
 * block in `apps/web/src/index.css`), served from the app origin. Artifact
 * previews keep an opaque-origin sandbox, so browsers may reject these font
 * loads and fall back to the system sans stack; that is acceptable for v1.
 */
export const font = {
  family: "Open Runde",
  /** Applied to `font-family` — the brand face first, then a system fallback stack. */
  stack:
    '"Open Runde", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  faces: [
    { url: "/fonts/OpenRunde-Medium.woff2", weight: "400 550" },
    { url: "/fonts/OpenRunde-Semibold.woff2", weight: "551 800" },
  ],
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/**
 * Type ramp in px (authoring canvas is a fixed logical size, so px is stable).
 * `display` heads a title page; `eyebrow`/`caption` are the small marks.
 *
 * This ramp is calibrated for SLIDES — a 1280x720 page read at a distance, so
 * type is large and one idea fills a page. A `pdf` document is a different
 * medium (816x1056, read up close, dense), so it gets its own denser ramp in
 * `docType` below. Mixing the two mediums on one ramp is what pushed the model
 * to hand-roll a tiny off-token type scale for a resume.
 */
export const type = {
  display: "72px",
  title: "48px",
  headline: "32px",
  subhead: "24px",
  body: "18px",
  caption: "15px",
  eyebrow: "13px",
  lineTight: "1.04",
  lineSnug: "1.28",
  lineBody: "1.55",
  /**
   * Tracking is SIZE-SPECIFIC (Apple typography rule): large display text reads
   * too loose unless it is tightened, small text reads too cramped unless it is
   * loosened. A single global value is wrong somewhere, so each ramp step carries
   * its own — heads tighten hard, body sits near zero, the smallest marks open up.
   */
  track: {
    display: "-0.035em",
    title: "-0.03em",
    headline: "-0.022em",
    subhead: "-0.015em",
    body: "-0.008em",
    caption: "0em",
    eyebrow: "0.04em",
  },
  /** Default body tracking (near zero). Kept for the base <body> rule. */
  tracking: "-0.008em",
} as const;

/**
 * Document type ramp for the `pdf` medium (resumes, one-pagers, reports). Denser
 * than the slide `type` ramp because a US-Letter page is read up close and packs
 * more per page — but with a hard readable FLOOR (`body` 14px, the smallest mark
 * 11px) so a document can never regress to the 10px-and-hardcoded-grey soup the
 * model reaches for when left to free-style. Everything derives from here so the
 * shell classes, templates, and prompt floor cite one source.
 */
export const docType = {
  /** Résumé/report name or document title. */
  name: "32px",
  /** Role line under the name; lead-in subtitle. */
  role: "15px",
  /** Section label (uppercase, tracked): "Experience", "Education". */
  section: "11px",
  /** Entry title — a job/role/project name. */
  heading: "15px",
  /** Body copy — descriptions, prose. The readable floor for documents. */
  body: "14px",
  /** Dates, captions, right-column meta. */
  meta: "12px",
  lineHeading: "1.25",
  lineBody: "1.5",
} as const;

/** 4px-based spacing scale for gaps, padding, and page margins. */
export const spacing = {
  xs: "8px",
  sm: "12px",
  md: "20px",
  lg: "32px",
  xl: "48px",
  xxl: "72px",
  /** Default inset from the page edge to content. */
  pageInset: "64px",
} as const;

/** Corner radii — the app grammar lives at the extremes (small + 16px). */
export const radii = {
  sm: "8px",
  md: "12px",
  lg: "16px",
  full: "9999px",
} as const;

/**
 * A three-step elevation scale, not a single hairline. Each level layers a soft
 * ambient shadow, a tighter key shadow, and a hairline ring — the recipe that
 * makes a surface read as a real material lit from above rather than a flat grey
 * rectangle with a 1px outline. Shadows are tinted with the ink hue
 * (rgba(24,25,37,...)) so they share the page's temperature instead of muddying
 * it with pure black. `sm` is for chips and inline marks, `md` for cards, `lg`
 * for the one hero surface on a page.
 */
export const shadow = {
  sm: "0 1px 2px rgba(24, 25, 37, 0.05), 0 0 0 1px rgba(24, 25, 37, 0.04)",
  md: "0 1px 2px rgba(24, 25, 37, 0.04), 0 6px 16px -4px rgba(24, 25, 37, 0.08), 0 0 0 1px rgba(24, 25, 37, 0.045)",
  lg: "0 2px 4px rgba(24, 25, 37, 0.04), 0 16px 40px -8px rgba(24, 25, 37, 0.14), 0 0 0 1px rgba(24, 25, 37, 0.05)",
  /** Recessed inset for a quiet sunken surface (panel). */
  inset: "inset 0 1px 2px rgba(24, 25, 37, 0.03)",
  /** Deeper inset for a carved track (bar chart). */
  insetStrong: "inset 0 1px 2px rgba(24, 25, 37, 0.06)",
} as const;

/**
 * The DARK elevation scale. On a dark ground a soft grey drop shadow is
 * invisible, so depth is carried instead by (a) the surface being lighter than
 * the page, (b) a heavier BLACK ambient drop for separation, and (c) a faint
 * light top-ring (`rgba(255,255,255,…)`) that reads as a lit upper edge. Insets
 * darken hard so a recessed panel/track reads carved into the charcoal.
 */
export const darkShadow = {
  sm: "0 1px 2px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06)",
  md: "0 2px 4px rgba(0, 0, 0, 0.4), 0 10px 28px -8px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.07)",
  lg: "0 4px 10px rgba(0, 0, 0, 0.45), 0 28px 64px -12px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(255, 255, 255, 0.08)",
  inset: "inset 0 1px 2px rgba(0, 0, 0, 0.5)",
  insetStrong: "inset 0 1px 3px rgba(0, 0, 0, 0.6)",
} as const;

/**
 * Fixed logical page geometry per format — the canvas archetypes are authored
 * against and the shell locks the body to. Kept in lockstep with `PAGE_GEOMETRY`
 * in `apps/web/src/components/artifact-page-frame.tsx` (which sizes the iframe):
 * `slides` is a 1280x720 16:9 deck page, `pdf` is portrait US-Letter at 96dpi.
 */
export const pageGeometry: Record<
  ArtifactFormat,
  { readonly width: number; readonly height: number }
> = {
  slides: { width: 1280, height: 720 },
  pdf: { width: 816, height: 1056 },
};

/**
 * The themeable design roles — every `--art-*` custom property whose value
 * CHANGES between light and dark. Pairing `light` + `dark` in ONE entry is the
 * enforcement that keeps the two schemes in lockstep: a role added here MUST
 * supply both values or it won't type-check (the `satisfies` below), so dark can
 * never silently inherit a light value — the white-blowout failure mode a
 * hand-maintained parallel list invites. Values come from the palette / accent /
 * shadow objects above and are never restated here. The shell writes `light`
 * into `:root` and `dark` into `:root[data-theme="dark"]`, so one stamped
 * attribute reskins every surface, mark, and shadow at once — retroactively,
 * with no stored bytes.
 */
const themedTokens = {
  "art-ink": { light: palette.ink, dark: darkPalette.ink },
  "art-fg-muted": { light: palette.fgMuted, dark: darkPalette.fgMuted },
  "art-fg-subtle": { light: palette.fgSubtle, dark: darkPalette.fgSubtle },
  "art-fg-faint": { light: palette.fgFaint, dark: darkPalette.fgFaint },
  "art-surface": { light: palette.surface, dark: darkPalette.surface },
  "art-surface-raised": { light: palette.surfaceRaised, dark: darkPalette.surfaceRaised },
  "art-surface-sunken": { light: palette.surfaceSunken, dark: darkPalette.surfaceSunken },
  "art-surface-deep": { light: palette.surfaceDeep, dark: darkPalette.surfaceDeep },
  "art-surface-hi": { light: palette.surfaceHi, dark: darkPalette.surfaceHi },
  "art-border": { light: palette.border, dark: darkPalette.border },
  "art-border-strong": { light: palette.borderStrong, dark: darkPalette.borderStrong },
  "art-accent-from": { light: accent.from, dark: darkAccent.from },
  "art-accent-to": { light: accent.to, dark: darkAccent.to },
  "art-accent-soft": { light: accent.soft, dark: darkAccent.soft },
  "art-accent": { light: accent.from, dark: darkAccent.from },
  "art-shadow-sm": { light: shadow.sm, dark: darkShadow.sm },
  "art-shadow": { light: shadow.md, dark: darkShadow.md },
  "art-shadow-lg": { light: shadow.lg, dark: darkShadow.lg },
  "art-inset": { light: shadow.inset, dark: darkShadow.inset },
  "art-inset-strong": { light: shadow.insetStrong, dark: darkShadow.insetStrong },
} satisfies Record<string, { light: string; dark: string }>;

/**
 * Theme-INVARIANT tokens — emitted once into `:root` and inherited by both
 * schemes because their values do not change between light and dark: the
 * categorical hue marks, corner radii, and the document type scale. Caveat: the
 * hues are tuned for marks on a LIGHT ground and are reused unchanged in dark for
 * v1 — a legible but not re-optimised choice; a dedicated dark hue set is the
 * revisit if a hue-driven mark reads wrong on charcoal.
 */
const invariantTokens: readonly DesignToken[] = [
  { name: "art-hue-blue", value: hues.blue },
  { name: "art-hue-green", value: hues.green },
  { name: "art-hue-amber", value: hues.amber },
  { name: "art-hue-red", value: hues.red },
  { name: "art-hue-purple", value: hues.purple },
  { name: "art-hue-sky", value: hues.sky },
  { name: "art-hue-pink", value: hues.pink },
  { name: "art-hue-orange", value: hues.orange },
  { name: "art-radius-sm", value: radii.sm },
  { name: "art-radius-md", value: radii.md },
  { name: "art-radius-lg", value: radii.lg },
  { name: "art-radius-full", value: radii.full },
  { name: "art-doc-name", value: docType.name },
  { name: "art-doc-role", value: docType.role },
  { name: "art-doc-section", value: docType.section },
  { name: "art-doc-heading", value: docType.heading },
  { name: "art-doc-body", value: docType.body },
  { name: "art-doc-meta", value: docType.meta },
  { name: "art-doc-line-heading", value: docType.lineHeading },
  { name: "art-doc-line-body", value: docType.lineBody },
];

/**
 * The light `:root` set — the `light` half of every themed role plus the
 * invariant tokens. Emitting from here (rather than restating the hexes in the
 * shell) is what keeps the rendered surface and the authoring prompt on one
 * source of truth.
 */
export function cssVariables(): DesignToken[] {
  return [
    ...Object.entries(themedTokens).map(([name, value]) => ({ name, value: value.light })),
    ...invariantTokens,
  ];
}

/**
 * The dark override set — the `dark` half of every themed role, derived from the
 * same `themedTokens` table so it cannot drift from the light set. The shell
 * emits these under `:root[data-theme="dark"]`; the invariant tokens are
 * inherited from the light `:root` and deliberately not repeated.
 */
export function cssVariablesDark(): DesignToken[] {
  return Object.entries(themedTokens).map(([name, value]) => ({ name, value: value.dark }));
}
