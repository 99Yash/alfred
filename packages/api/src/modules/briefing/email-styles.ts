/**
 * Inline style tokens for the briefing HTML email shell. Email clients strip
 * `<style>`/class-based CSS, so every rule ships inline on the element — these
 * are the shared string constants both the reference renderer
 * (`references.ts`) and the digest composer (`compose.ts`) interpolate into
 * their markup. Kept in their own leaf so neither importer owns styling it
 * doesn't define.
 */

export const EMAIL_WRAPPER_STYLE =
  'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; color: #1a1a1a; line-height: 1.5;';
export const EMAIL_P_STYLE = "margin: 0 0 16px 0; font-size: 15px;";
export const EMAIL_LINK_STYLE = "color: #2563eb; text-decoration: none;";
