import { buildArtifactDocument } from "@alfred/artifacts-design/shell";
import { darkPalette, pageGeometry, palette } from "@alfred/artifacts-design/tokens";
import type { ArtifactFormat } from "@alfred/contracts";
import { use, useCallback, useState } from "react";
import { AppThemeContext } from "~/components/ui/v2/theme";
import { cn } from "~/lib/utils";

const PAGE_ASPECT: Record<ArtifactFormat, string> = {
  pdf: "aspect-[8.5/11]",
  slides: "aspect-video",
};

export function ArtifactPageFrame({
  html,
  title,
  className,
  format = "pdf",
}: {
  html: string;
  title: string;
  className?: string;
  /** Drives page geometry/aspect. Defaults to `pdf` (portrait US-Letter). */
  format?: ArtifactFormat;
}) {
  const { width: pageWidth, height: pageHeight } = pageGeometry[format];
  const aspect = PAGE_ASPECT[format];

  // Follow the app's resolved theme so an artifact rendered inside dark Alfred
  // reads as a dark sheet instead of a white blowout. Read the context
  // defensively (not via `useAppTheme`, which throws) so a preview rendered
  // outside the provider falls back to the print-friendly light scheme. The
  // shell's dark variant is a render-time reskin — the stored page HTML is
  // theme-agnostic — so changing themes only re-stamps `data-theme`.
  const theme = use(AppThemeContext)?.resolved ?? "light";
  const surfaceColor = theme === "dark" ? darkPalette.surface : palette.surface;
  // `width` is undefined until the frame has been measured. The iframe falls
  // back to scale 1 in that single pre-measurement frame; ResizeObserver fires
  // synchronously on attach, so the unscaled frame is rarely visible.
  const [width, setWidth] = useState<number | undefined>(undefined);

  // Callback ref with a cleanup return (React 19) replaces a useState-in-effect
  // pattern — the observer attaches when the node mounts and disconnects when
  // it unmounts, without a separate useEffect to read DOM state at init time.
  const frameRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    // Read the layout content-box from the ResizeObserver entry rather than
    // `getBoundingClientRect()`, which folds in ancestor CSS transforms — an
    // animating `scale(...)` ancestor (e.g. the fullscreen present entrance)
    // would otherwise be measured mid-animation and leave the iframe scaled to
    // the shrunken width once the transform settles.
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? 0;
      if (nextWidth > 0) setWidth(nextWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = width !== undefined ? width / pageWidth : 1;

  return (
    <div
      ref={frameRef}
      className={cn("relative overflow-hidden rounded-lg shadow-2xl", aspect, className)}
      // Match the page surface so the rounded frame and any pre-paint flash read
      // as the artifact's own background, not a stray white edge in dark mode.
      style={{ backgroundColor: surfaceColor }}
    >
      <iframe
        title={title}
        srcDoc={buildArtifactDocument(html, format, theme)}
        // Keep the frame on an opaque origin: scripts, forms, top navigation,
        // storage, and parent DOM access all stay blocked. Same-origin font
        // files may fall back to the system stack here, which is acceptable for
        // previews and safer than relaxing the sandbox.
        sandbox=""
        className="pointer-events-none absolute top-0 left-0 border-0"
        style={{
          width: pageWidth,
          height: pageHeight,
          backgroundColor: surfaceColor,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      />
    </div>
  );
}
