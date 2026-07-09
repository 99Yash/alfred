import { buildArtifactPrintDocument } from "@alfred/artifacts-design/shell";
import type { ArtifactFormat } from "@alfred/contracts";

/**
 * Browser-native "Save as PDF" export for a `kind: "pages"` artifact
 * (pristine-artifacts Phase 3a). No server, no headless Chromium: because every
 * page is already a self-contained house-shell document with locked geometry,
 * the browser's own print engine can emit a 1:1 PDF, one artifact page per
 * sheet, straight from the design-system shell.
 *
 * The on-screen render iframe is `sandbox=""` (scripts + modals blocked), so it
 * cannot call `print()` on itself. Instead we build a fresh, NON-sandboxed,
 * off-screen iframe from `buildArtifactPrintDocument`, print it, and tear it
 * down once the print dialog closes. The print document intentionally uses the
 * same no-web-font shell as the preview, so downloaded output does not drift to
 * Open Runde just because the export iframe is unsandboxed.
 */
export async function printArtifactPages(
  pages: readonly string[],
  format: ArtifactFormat,
  title: string,
): Promise<void> {
  if (pages.length === 0) return;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  // Off-screen rather than display:none — a non-rendered iframe won't paint
  // fonts/layout, which the print engine needs measured before it captures.
  Object.assign(iframe.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "1px",
    height: "1px",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  iframe.srcdoc = buildArtifactPrintDocument(pages, format, title);

  await new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
    document.body.appendChild(iframe);
  });

  const frameWindow = iframe.contentWindow;
  if (!frameWindow) {
    iframe.remove();
    return;
  }

  const cleanup = () => iframe.remove();
  // `afterprint` fires when the dialog closes (print or cancel). Keep a long
  // fallback in case the event never arrives (some engines skip it).
  frameWindow.addEventListener("afterprint", cleanup, { once: true });
  window.setTimeout(cleanup, 60_000);

  frameWindow.focus();
  frameWindow.print();
}
