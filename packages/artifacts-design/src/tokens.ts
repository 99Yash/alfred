import type { ArtifactFormat } from "@alfred/contracts";

/**
 * Artifact design tokens. The shell, the authoring prompt, and the archetypes all read these.
 * Values follow the app's `--app-*` colors in `apps/web/src/index.css`.
 * Pure data, so both `apps/web` and `packages/assistant` can import it.
 */

/** A CSS custom property, name without the leading `--`. */
export interface DesignToken {
  readonly name: string;
  readonly value: string;
}

/** Light text and surface colors. Neutrals have a faint cool tint to match the ink. */
export const palette = {
  /** Primary text. Mirrors `--app-fg-4`. */
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
  /** Top stop of a card or chip gradient. Its own token so dark mode avoids a white top edge. */
  surfaceHi: "#ffffff",

  /** Hairline border. */
  border: "#e5e5ec",
  /** Stronger divider. */
  borderStrong: "#cfcfda",
} as const;

/**
 * Dark counterpart of `palette`.
 * Raised cards are lighter than the page and sunken panels are darker, the reverse of light mode.
 */
export const darkPalette = {
  /** Primary text. */
  ink: "#f4f5fb",
  /** Body / secondary text. */
  fgMuted: "#a8aab8",
  /** Captions, eyebrows, metadata. */
  fgSubtle: "#7d7e8d",
  /** Hairlines, disabled, faintest text. */
  fgFaint: "#54555f",

  /** Page background. */
  surface: "#0d0d12",
  /** Raised card fill, lighter than the page. */
  surfaceRaised: "#1a1a23",
  /** Recessed panel fill, darker than the page. */
  surfaceSunken: "#08080c",
  /** Deepest fill. */
  surfaceDeep: "#050508",
  /** Top stop of a raised surface gradient. */
  surfaceHi: "#23232f",

  /** Hairline border. */
  border: "#282832",
  /** Stronger divider. */
  borderStrong: "#3a3a45",
} as const;

/** Brand purple gradient, matching `--app-cta-bg`. Text on `soft` uses `to` for contrast. */
export const accent = {
  from: "#6b62f2",
  to: "#4f37cb",
  /** Faint accent tint for wash backgrounds / selected rows. */
  soft: "#f1f1fe",
} as const;

/** The accent made brighter, because the light purple looks muddy on charcoal. */
export const darkAccent = {
  from: "#8f87ff",
  to: "#7a69f4",
  /** Accent-tinted charcoal for wash and badge fills. */
  soft: "#1d1936",
} as const;

/** Hues for charts, badges, and dots. Tuned for marks on white, not for body text. */
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

/** Brand font. The shell inlines it from `./fonts`, because the sandbox cannot load `faces` URLs. */
export const font = {
  family: "Open Runde",
  /** Brand face, then a system fallback. */
  stack:
    '"Open Runde", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  faces: [
    { url: "/fonts/OpenRunde-Medium.woff2", weight: "400 550" },
    { url: "/fonts/OpenRunde-Semibold.woff2", weight: "551 800" },
  ],
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/** Slide type ramp in px. Documents use the denser `docType`. */
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
  /** Tracking per size: large type tightens, small type opens up. */
  track: {
    display: "-0.035em",
    title: "-0.03em",
    headline: "-0.022em",
    subhead: "-0.015em",
    body: "-0.008em",
    caption: "0em",
    eyebrow: "0.04em",
  },
  /** Tracking for the base `<body>` rule. */
  tracking: "-0.008em",
} as const;

/** Denser type ramp for `pdf` documents. Body 14px and marks 11px are the floor. */
export const docType = {
  /** Name or document title. */
  name: "32px",
  /** Role line under the name; lead-in subtitle. */
  role: "15px",
  /** Uppercase section label, for example "Experience". */
  section: "11px",
  /** Entry title, for example a job. */
  heading: "15px",
  /** Body text. */
  body: "14px",
  /** Dates, captions, right-column meta. */
  meta: "12px",
  lineHeading: "1.25",
  lineBody: "1.5",
} as const;

/** Spacing scale. */
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

/** Corner radii. */
export const radii = {
  sm: "8px",
  md: "12px",
  lg: "16px",
  full: "9999px",
} as const;

/** Elevation: `sm` for chips, `md` for cards, `lg` for one hero surface. Tinted with the ink color, not black. */
export const shadow = {
  sm: "0 1px 2px rgba(24, 25, 37, 0.05), 0 0 0 1px rgba(24, 25, 37, 0.04)",
  md: "0 1px 2px rgba(24, 25, 37, 0.04), 0 6px 16px -4px rgba(24, 25, 37, 0.08), 0 0 0 1px rgba(24, 25, 37, 0.045)",
  lg: "0 2px 4px rgba(24, 25, 37, 0.04), 0 16px 40px -8px rgba(24, 25, 37, 0.14), 0 0 0 1px rgba(24, 25, 37, 0.05)",
  /** Inset for a sunken panel. */
  inset: "inset 0 1px 2px rgba(24, 25, 37, 0.03)",
  /** Deeper inset for a bar chart track. */
  insetStrong: "inset 0 1px 2px rgba(24, 25, 37, 0.06)",
} as const;

/** Dark elevation. A grey shadow is invisible on dark, so these use heavy black plus a faint white ring. */
export const darkShadow = {
  sm: "0 1px 2px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06)",
  md: "0 2px 4px rgba(0, 0, 0, 0.4), 0 10px 28px -8px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.07)",
  lg: "0 4px 10px rgba(0, 0, 0, 0.45), 0 28px 64px -12px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(255, 255, 255, 0.08)",
  inset: "inset 0 1px 2px rgba(0, 0, 0, 0.5)",
  insetStrong: "inset 0 1px 3px rgba(0, 0, 0, 0.6)",
} as const;

/** Fixed page size per format. `pdf` is US Letter at 96dpi. The web iframe also reads this. */
export const pageGeometry = {
  slides: { width: 1280, height: 720 },
  pdf: { width: 816, height: 1056 },
} satisfies Record<ArtifactFormat, { readonly width: number; readonly height: number }>;

/** Tokens that change with the theme. Each entry needs both values, so dark never inherits a light value. */
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

/** Tokens that do not change with the theme. The hues are tuned for light and reused in dark. */
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

/** Light `:root` variables: themed light values plus the invariant tokens. */
export function cssVariables(): DesignToken[] {
  return [
    ...Object.entries(themedTokens).map(([name, value]) => ({ name, value: value.light })),
    ...invariantTokens,
  ];
}

/** Dark override variables. Invariant tokens inherit from the light `:root`. */
export function cssVariablesDark(): DesignToken[] {
  return Object.entries(themedTokens).map(([name, value]) => ({ name, value: value.dark }));
}
