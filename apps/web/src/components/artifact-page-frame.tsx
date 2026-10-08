import { buildArtifactDocument } from "@alfred/artifacts-design/shell";
import { darkPalette, pageGeometry, palette } from "@alfred/artifacts-design/tokens";
import type { ArtifactFormat } from "@alfred/contracts";
import { use, useCallback, useState } from "react";
import { AppThemeContext } from "~/components/ui/v2/theme";
import { cn } from "~/lib/utils";

export function ArtifactPageFrame({
  html,
  title,
  className,
  format = "pdf",
}: {
  html: string;
  title: string;
  className?: string | undefined;
  /** Defaults to `pdf` (portrait US-Letter). */
  format?: ArtifactFormat | undefined;
}) {
  const { width: pageWidth, height: pageHeight } = pageGeometry[format];

  // Follow the app theme. Optional context, not `useAppTheme` (which throws),
  // so a preview outside the provider gets the print-friendly light scheme.
  const theme = use(AppThemeContext)?.resolved ?? "light";
  const surfaceColor = theme === "dark" ? darkPalette.surface : palette.surface;
  // Undefined until measured; the iframe uses scale 1 for that one frame.
  const [width, setWidth] = useState<number | undefined>(undefined);

  const frameRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;

    // Use the observer's content box: `getBoundingClientRect()` includes ancestor
    // transforms, so a mid-animation `scale(...)` would be measured.
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
      className={cn("relative overflow-hidden rounded-lg shadow-2xl", className)}
      // Page surface color, so no white edge flashes in dark mode. Aspect from `pageGeometry`.
      style={{ backgroundColor: surfaceColor, aspectRatio: `${pageWidth} / ${pageHeight}` }}
    >
      <iframe
        title={title}
        srcDoc={buildArtifactDocument(html, format, theme)}
        // Opaque origin blocks scripts, forms, navigation, storage, and parent DOM.
        // Same-origin fonts may fall back to system fonts; that is acceptable.
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
