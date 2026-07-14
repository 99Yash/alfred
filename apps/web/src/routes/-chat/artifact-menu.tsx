import type { SyncedArtifact } from "@alfred/sync";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, FileText, Files, Layers, Loader2 } from "lucide-react";
import { use, useId, useState } from "react";
import { AppThemeContext } from "~/components/ui/v2/theme";
import { cn } from "~/lib/utils";
import { IconButton } from "./rail/icon-button";
import { Tip } from "./tip";

/**
 * Persistent quick-access control for a thread's artifacts, mounted in the chat
 * top bar (ADR-0075). Before this, the only re-entry point to a finished
 * artifact was its `ArtifactTriggerCard` buried in the transcript — so
 * re-opening one meant scrolling to hunt for the authoring message. This gives
 * a stable, scroll-independent affordance that also conveys how many artifacts
 * a thread holds.
 *
 *   - 0 artifacts → renders nothing (the common case; keeps the bar clean).
 *   - 1 artifact  → a direct toggle button (open / hide the panel).
 *   - 2+          → a count button opening a popover to pick which to view.
 *
 * Content lives in the synced `artifacts` row; this only drives the shared
 * right-slot selection via the panel's `open`/`close`.
 */

function artifactIcon(artifact: SyncedArtifact, size: number) {
  if (artifact.status === "generating") return <Loader2 size={size} className="animate-spin" />;
  return artifact.kind === "pages" ? <Layers size={size} /> : <FileText size={size} />;
}

function artifactSubtitle(artifact: SyncedArtifact): string {
  if (artifact.status === "generating") return "Generating…";
  if (artifact.status === "error") return "Failed to generate";
  if (artifact.kind === "pages") return artifact.format === "slides" ? "Slides" : "PDF document";
  return "Document";
}

export function ArtifactMenu({
  artifacts,
  selectedId,
  onOpen,
  onClose,
}: {
  artifacts: SyncedArtifact[];
  selectedId: string | null;
  onOpen: (artifactId: string) => void;
  onClose: () => void;
}) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  // The popover portals out of the `.app` subtree, so CSS token inheritance
  // breaks — stamp the resolved theme on the content directly (React context
  // still flows through portals). Same pattern as `ModelTierPicker`.
  const themeCtx = use(AppThemeContext);
  const dataTheme =
    themeCtx?.mode === "dark" || themeCtx?.mode === "light" ? themeCtx.mode : undefined;

  if (artifacts.length === 0) return null;

  // Single artifact → the button toggles the panel directly; no menu needed.
  if (artifacts.length === 1) {
    const only = artifacts[0]!;
    const active = selectedId === only.id;
    return (
      <Tip label={active ? "Hide artifact" : `Open ${only.title}`}>
        <IconButton
          label={active ? "Hide artifact" : `Open artifact: ${only.title}`}
          active={active}
          onClick={() => (active ? onClose() : onOpen(only.id))}
        >
          {artifactIcon(only, 14)}
        </IconButton>
      </Tip>
    );
  }

  // 2+ artifacts → a count button opening a picker. The button reads "active"
  // whenever one of this thread's artifacts is the panel's current occupant.
  const panelShowsArtifact = artifacts.some((a) => a.id === selectedId);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <Tip label="View artifacts">
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-label={`Artifacts (${artifacts.length})`}
            className={cn(
              "app-press inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium",
              "transition-colors outline-none",
              "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
              panelShowsArtifact
                ? "bg-app-bg-2 text-app-fg-4 hover:bg-app-bg-a2"
                : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
              "data-[state=open]:bg-app-bg-a2 data-[state=open]:text-app-fg-4",
            )}
          >
            <Files size={14} />
            <span className="tabular-nums">{artifacts.length}</span>
          </button>
        </PopoverPrimitive.Trigger>
      </Tip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          id={listboxId}
          role="listbox"
          aria-label="Artifacts"
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          data-app-theme={dataTheme}
          className={cn(
            "app app-frost-overlay z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-0.5 overflow-hidden rounded-2xl p-1.5",
            "app-fade-in outline-none",
          )}
        >
          {artifacts.map((artifact) => {
            const checked = artifact.id === selectedId;
            return (
              <button
                key={artifact.id}
                type="button"
                role="option"
                aria-selected={checked}
                onClick={() => {
                  onOpen(artifact.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-xl p-2 text-left transition-colors outline-none",
                  "hover:bg-app-bg-a2 focus-visible:bg-app-bg-a2",
                  checked && "bg-app-bg-a2",
                )}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-app-bg-1 text-app-fg-3">
                  {artifactIcon(artifact, 15)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-app-fg-4">
                    {artifact.title}
                  </span>
                  <span className="block truncate text-[11.5px] text-app-fg-2">
                    {artifactSubtitle(artifact)}
                  </span>
                </span>
                {checked ? <Check size={14} className="shrink-0 text-app-purple-4" /> : null}
              </button>
            );
          })}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
