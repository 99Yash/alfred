# Dimension HTML reproductions

Static, sanitized HTML files that preserve Dimension UI behavior and accessibility contracts without shipping private account data.

These are not production components. They are executable references for rebuilding Alfred surfaces with React, Tailwind, and Radix primitives.

## Files

- [`chat-meeting-prep-2026-05-19.html`](./chat-meeting-prep-2026-05-19.html) — chat landing meeting-prep card + dialog, including keyboard navigation and accessibility reproduction steps.

## Review workflow

1. Open the HTML file directly in Chrome.
2. Use only the keyboard first: `Tab`, `Shift+Tab`, `Enter`, `Escape`.
3. Confirm focus visibility and focus restoration.
4. Then inspect the DOM roles and labels in DevTools Accessibility.
5. Compare visual dimensions against the markdown reference and screenshot archive.

