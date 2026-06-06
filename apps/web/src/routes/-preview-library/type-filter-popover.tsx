import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown, Filter } from "lucide-react";
import type { ArtifactType } from "~/lib/library-artifacts";
import { cn } from "~/lib/utils";

const TYPE_OPTIONS: ReadonlyArray<{ label: string; value: ArtifactType | "all" }> = [
  { label: "All types", value: "all" },
  { label: "Presentations", value: "presentation" },
  { label: "Documents", value: "document" },
  { label: "Spreadsheets", value: "spreadsheet" },
  { label: "PDF Documents", value: "pdf" },
];

export function TypeFilterPopover({
  selectedTypes,
  onSelectedTypesChange,
}: {
  selectedTypes: Set<ArtifactType>;
  onSelectedTypesChange: (types: Set<ArtifactType>) => void;
}) {
  const toggleType = (value: ArtifactType | "all") => {
    if (value === "all") {
      onSelectedTypesChange(new Set());
      return;
    }
    const next = new Set(selectedTypes);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onSelectedTypesChange(next);
  };
  const label = selectedTypes.size === 0 ? "All types" : `${selectedTypes.size} selected`;

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-xl px-3",
            "bg-app-bg-1 text-sm font-medium text-app-fg-4",
            "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.06)]",
            "outline-none transition-colors hover:bg-app-bg-a1",
            "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
            "data-[state=open]:bg-app-bg-a1",
            "app-press",
          )}
        >
          <Filter size={13} />
          {label}
          <ChevronDown size={13} className="text-app-fg-2" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className={cn(
            "z-50 w-[250px] rounded-2xl bg-app-bg-1 p-2",
            "shadow-[0_18px_48px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.06)]",
            "outline-none app-fade-in",
          )}
        >
          <div className="mb-1 px-2 pb-1 pt-1 text-[11px] uppercase tracking-tight text-app-fg-2">
            Filter types
          </div>
          <div aria-label="Artifact types" className="space-y-0.5">
            {TYPE_OPTIONS.map((type) => {
              const checked =
                type.value === "all" ? selectedTypes.size === 0 : selectedTypes.has(type.value);
              return (
                <button
                  key={type.value}
                  type="button"
                  aria-pressed={checked}
                  onClick={() => toggleType(type.value)}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm",
                    "text-app-fg-3 outline-none transition-colors",
                    "hover:bg-app-bg-a1 hover:text-app-fg-4",
                    "focus-visible:bg-app-bg-a1 focus-visible:text-app-fg-4",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded text-[10px]",
                      checked
                        ? "bg-[image:var(--app-cta-bg)] text-[var(--app-accent-fg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
                        : "bg-app-bg-2 text-transparent shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]",
                    )}
                  >
                    <Check size={11} strokeWidth={2.4} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{type.label}</span>
                </button>
              );
            })}
          </div>
          {selectedTypes.size > 0 ? (
            <button
              type="button"
              onClick={() => onSelectedTypesChange(new Set())}
              className={cn(
                "mt-1 h-7 w-full rounded-lg text-[12px] text-app-fg-3 outline-none",
                "hover:bg-app-bg-a1 hover:text-app-fg-4",
                "focus-visible:ring-2 focus-visible:ring-app-purple-2",
              )}
            >
              Clear filters
            </button>
          ) : null}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
