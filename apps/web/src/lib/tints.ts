/**
 * Shared tint palette for pastel category tiles — one CSS class pair per tone,
 * following `bg-app-{tone}-1 text-app-{tone}-4`. This record is the single
 * source of truth for every feature that renders a tinted chip (the chat rail's
 * tool tones, the settings background-agent tiles). The tone union derives from
 * these keys via `keyof typeof`, so adding a tone here surfaces it everywhere
 * the union is consumed rather than drifting per-feature.
 */
export const APP_TINTS = {
  sky: "bg-app-sky-1 text-app-sky-4",
  amber: "bg-app-amber-1 text-app-amber-4",
  purple: "bg-app-purple-1 text-app-purple-4",
  green: "bg-app-green-1 text-app-green-4",
  pink: "bg-app-pink-1 text-app-pink-4",
  orange: "bg-app-orange-1 text-app-orange-4",
} as const;

export type AppTint = keyof typeof APP_TINTS;
