import type { ComponentType, SVGProps } from "react";

/**
 * Model-provider brand marks + id helpers, shared by every surface that shows
 * which model served some work (the chat per-turn usage line, the settings
 * usage table). Marks are monochrome Simple Icons paths drawn in `currentColor`
 * (or an inline `color`), so a served model is recognizable at a glance.
 */

export type SvgIcon = ComponentType<SVGProps<SVGSVGElement>>;

export const AnthropicMark: SvgIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path d="M17.3 3.54h-3.67l6.7 16.92H24Zm-10.61 0L0 20.46h3.74l1.37-3.55h7.01l1.37 3.55h3.74L10.54 3.54Zm-.37 10.22 2.29-5.95 2.29 5.95Z" />
  </svg>
);
/**
 * The full-color Google "G" rather than the monochrome Gemini spark — the spark
 * reads as a generic sparkle at 12px, while the four-color G is recognized
 * instantly. Fills are fixed brand hues, so it ignores `color`/`currentColor`.
 */
export const GoogleMark: SvgIcon = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden {...props}>
    <path
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      fill="#4285F4"
    />
    <path
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      fill="#34A853"
    />
    <path
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      fill="#FBBC05"
    />
    <path
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      fill="#EA4335"
    />
  </svg>
);
export const OpenAiMark: SvgIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.79 .79 0 0 0 .39-.68v-6.74l2.02 1.17a.07 .07 0 0 1 .04 .05v5.58a4.5 4.5 0 0 1-4.49 4.49zm-9.66-4.13a4.47 4.47 0 0 1-.53-3.01l.14 .09 4.78 2.76a.77 .77 0 0 0 .78 0l5.84-3.37v2.33a.08 .08 0 0 1-.03 .06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97V11.6a.77 .77 0 0 0 .39 .68l5.81 3.35-2.02 1.17a.08 .08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.87zm16.6 3.86L13.1 8.36 15.12 7.2a.08 .08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79 .79 0 0 0-.41-.67zm2.01-3.02l-.14-.09-4.77-2.78a.78 .78 0 0 0-.79 0L9.41 9.23V6.9a.07 .07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a.08 .08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14 .08L8.7 5.46a.79 .79 0 0 0-.39 .68zm1.1-2.37l2.6-1.5 2.61 1.5v3l-2.6 1.5-2.61-1.5Z" />
  </svg>
);

export interface ProviderMeta {
  label: string;
  /** Brand tint for the mark — a saturated mid-tone that reads on both themes. */
  tint: string;
  Icon: SvgIcon;
}

export const PROVIDERS = {
  anthropic: { label: "Claude", tint: "#d97757", Icon: AnthropicMark },
  google: { label: "Gemini", tint: "#4285f4", Icon: GoogleMark },
  openai: { label: "GPT", tint: "#10a37f", Icon: OpenAiMark },
} satisfies Record<string, ProviderMeta>;

/** Boss turns run on Anthropic; anything else here degraded through `withFallback`. */
export function providerOf(model: string): ProviderMeta | null {
  if (model.startsWith("claude")) return PROVIDERS.anthropic;
  if (model.startsWith("gemini")) return PROVIDERS.google;
  if (model.startsWith("gpt")) return PROVIDERS.openai;
  return null;
}

/** Trim a model id's dated suffix ("claude-haiku-4-5-20251001" → "claude-haiku-4-5"). */
export function shortModel(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

/**
 * The provider carries the icon, so the chip label drops the redundant vendor
 * prefix: "claude-haiku-4-5" → "haiku-4-5", "gemini-3.5-flash" → "3.5-flash".
 */
export function modelLabel(id: string): string {
  return shortModel(id).replace(/^(claude|gemini|gpt)-/, "");
}
