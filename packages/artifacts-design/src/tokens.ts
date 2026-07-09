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
 * Ink + neutral surfaces, lifted from the app light theme. `ink` is the brand
 * foreground (`--app-fg-4`, never pure black); the `fg*` stops step down to
 * muted captions; `surface*` climb from page white to the deepest panel fill.
 */
export const palette = {
  /** Brand ink — primary text. Mirrors `--app-fg-4`. */
  ink: "#181925",
  /** Body / secondary text. */
  fgMuted: "#666666",
  /** Captions, eyebrows, metadata. */
  fgSubtle: "#999999",
  /** Hairlines, disabled, faintest text. */
  fgFaint: "#b3b3b3",

  /** Page background. */
  surface: "#ffffff",
  /** Raised panel / card fill. */
  surfaceRaised: "#f5f5f5",
  /** Deeper panel fill. */
  surfaceSunken: "#f0f0f0",
  /** Deepest fill / rule. */
  surfaceDeep: "#e8e8e8",

  /** Hairline border. */
  border: "#e0e0e0",
  /** Stronger divider. */
  borderStrong: "#cccccc",
} as const;

/**
 * The brand accent — the one saturated purple used for emphasis, CTAs, chart
 * fills, and active marks. A vertical gradient from `from` -> `to`, matching
 * `--app-cta-bg`; `fg` is the on-accent text color.
 */
export const accent = {
  from: "#6b62f2",
  to: "#4f37cb",
  fg: "#ffffff",
  /** Faint accent tint for wash backgrounds / selected rows. */
  soft: "#f1f1fe",
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
 * block in `apps/web/src/index.css`), served from the app origin. The iframe
 * `srcDoc` resolves these absolute paths against the parent document's origin,
 * and `@font-face`/`<link>` fonts DO load under `sandbox=""` (only scripts are
 * blocked), so the shell can embed the real brand font with no CDN.
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
 */
export const type = {
  display: "72px",
  title: "48px",
  headline: "32px",
  subhead: "24px",
  body: "18px",
  caption: "15px",
  eyebrow: "13px",
  lineTight: "1.1",
  lineSnug: "1.3",
  lineBody: "1.55",
  /** App-wide tracking (`.app` sets -0.02em); heads tighten further inline. */
  tracking: "-0.02em",
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

/** The app's hairline + drop stack, in one box-shadow (`--app-shadow-elevated`). */
export const shadow = {
  elevated: "0 1px 1px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.05)",
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
 * Flatten the palette/accent/type/etc into the `--art-*` custom properties the
 * shell writes into `:root` and body-level HTML consumes (e.g.
 * `color: var(--art-ink)`). Emitting from here (rather than restating the hexes
 * in the shell) is what keeps the rendered surface and the authoring prompt on
 * one source of truth.
 */
export function cssVariables(): DesignToken[] {
  return [
    { name: "art-ink", value: palette.ink },
    { name: "art-fg-muted", value: palette.fgMuted },
    { name: "art-fg-subtle", value: palette.fgSubtle },
    { name: "art-fg-faint", value: palette.fgFaint },
    { name: "art-surface", value: palette.surface },
    { name: "art-surface-raised", value: palette.surfaceRaised },
    { name: "art-surface-sunken", value: palette.surfaceSunken },
    { name: "art-surface-deep", value: palette.surfaceDeep },
    { name: "art-border", value: palette.border },
    { name: "art-border-strong", value: palette.borderStrong },
    { name: "art-accent-from", value: accent.from },
    { name: "art-accent-to", value: accent.to },
    { name: "art-accent-fg", value: accent.fg },
    { name: "art-accent-soft", value: accent.soft },
    { name: "art-accent", value: accent.from },
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
    { name: "art-shadow", value: shadow.elevated },
  ];
}
