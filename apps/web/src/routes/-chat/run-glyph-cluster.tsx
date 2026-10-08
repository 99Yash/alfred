import { Wrench } from "lucide-react";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import type { RunGlyph } from "./run-summary";

const MAX_GLYPHS = 3;

/** Overlapping coins for a run's glyphs, in first-hit order. A lone wrench when none map. */
export function RunGlyphCluster({ glyphs }: { glyphs: RunGlyph[] }) {
  if (glyphs.length === 0) {
    return (
      <span
        aria-hidden
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 text-app-fg-3 shadow-(--app-shadow-elevated)"
      >
        <Wrench size={13} />
      </span>
    );
  }

  // Ring in the page color, so overlaps read as a clean stack.
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {glyphs.slice(0, MAX_GLYPHS).map((glyph, i) =>
        glyph.kind === "brand" ? (
          <IntegrationIcon
            key={glyph.key}
            brand={glyph.brand}
            size="xs"
            className={cn("ring-2 ring-app-background", i > 0 && "-ml-2")}
          />
        ) : (
          // Static here; it plays on row hover.
          <span
            key={glyph.key}
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 text-app-fg-3 shadow-(--app-shadow-elevated) ring-2 ring-app-background",
              i > 0 && "-ml-2",
            )}
          >
            <glyph.Icon size={13} className="tool-animated-icon tool-animated-icon--hoverable" />
          </span>
        ),
      )}
    </span>
  );
}
