import { buildArtifactPrintDocument } from "@alfred/artifacts-design/shell";
import type { ArtifactFormat } from "@alfred/contracts";

/**
 * "Save as PDF" for a `pages` artifact through the browser's print engine, one page per sheet.
 * Uses a fresh off-screen iframe, because the on-screen one blocks modals.
 * Never grant `allow-scripts`: artifact HTML is model-authored.
 */
export async function printArtifactPages(
  pages: readonly string[],
  format: ArtifactFormat,
  title: string,
): Promise<void> {
  if (pages.length === 0) return;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  // `allow-modals` permits `print()`; `allow-same-origin` lets the parent call it.
  iframe.sandbox.add("allow-modals", "allow-same-origin");
  iframe.tabIndex = -1;
  // Not `display:none`: the print engine needs fonts and layout measured.
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
  // Some engines never fire `afterprint`, so keep a fallback.
  frameWindow.addEventListener("afterprint", cleanup, { once: true });
  window.setTimeout(cleanup, 60_000);

  frameWindow.focus();
  frameWindow.print();
}
