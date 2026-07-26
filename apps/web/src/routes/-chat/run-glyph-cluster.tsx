import { Wrench } from "lucide-react";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import type { RunGlyph } from "./run-summary";

/** Max coins stacked in the summary cluster before we stop adding more. */
const MAX_GLYPHS = 3;

/**
 * Overlapping coins for the glyphs a run touched (max 3) — integration app-icon
 * tiles and/or system marks, in the order the run first hit them, as picked by
 * `runGlyphs`. A run with no mappable glyph (only unmapped system plumbing)
 * falls back to a lone wrench.
 *
 * Shared by the turn's top-level activity trail and a sub-agent's nested one,
 * so a finished child run reads in the same vocabulary as a finished turn.
 */
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
  // ring matches the page background so overlapping coins read as a clean stack
  // rather than a smudge.
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
          // System tool with no brand — its animated mark on a neutral coin,
          // sized to match the brand tiles. Static here; plays on row hover.
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
