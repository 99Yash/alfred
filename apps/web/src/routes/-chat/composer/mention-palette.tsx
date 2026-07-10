import { useCallback, useEffect, useRef } from "react";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import type { MentionOption } from "../mention-options";

export function MentionPalette({
  options,
  activeIdx,
  onHover,
  onPick,
  onClose,
}: {
  options: ReadonlyArray<MentionOption>;
  activeIdx: number;
  onHover: (i: number) => void;
  onPick: (option: MentionOption) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click outside the palette closes it. Pointerdown beats pointerup so the
  // click never lands on whatever's underneath.
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = e.target as Node | null;
      // Don't close on clicks inside the palette, or inside the composer
      // form (the textarea is the trigger surface — clicking it should
      // keep the palette open so the user can continue typing).
      if (target && (root.contains(target) || root.closest("form")?.contains(target))) {
        return;
      }
      onClose();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [onClose]);

  // Scroll the active row into view as soon as React attaches its DOM node.
  // Wiring this through a ref callback (instead of a useEffect on activeIdx)
  // means the scroll fires from the same render that swapped the active
  // option — no extra render-then-effect step — and only when the active
  // node identity actually changes. `block: "nearest"` is a no-op once the
  // row is visible, so the list doesn't twitch on hover.
  const scrollActiveIntoView = useCallback((el: HTMLButtonElement | null) => {
    if (el) el.scrollIntoView({ block: "nearest" });
  }, []);

  const labelId = "mention-palette-label";
  return (
    <div
      ref={rootRef}
      className={cn(
        "absolute right-0 bottom-full left-0 z-20 mb-2",
        "app-elevated rounded-2xl bg-app-bg-1 p-1.5",
        "max-h-72 overflow-y-auto",
        // Subtle entry — slide up + fade. Tailwind's `animate-in` keyframes
        // ship with the project (used elsewhere as `app-card-in`); fall back
        // to a plain fade so it never appears static.
        "transition-opacity duration-150 ease-out",
      )}
    >
      <p
        id={labelId}
        className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-tight text-app-fg-2 uppercase"
      >
        Mention a source
      </p>
      {/* `role="menu"` rather than `role="listbox"` here is a deliberate
       * compromise: react-doctor's prefer-tag-over-role maps listbox →
       * <datalist> (no rich rows possible) and <ul role="listbox"> trips
       * no-noninteractive-element-to-interactive-role. Semantically the
       * palette is a popup the user picks one item from — `menu` /
       * `menuitem` cover that and don't conflict with either rule. */}
      <div role="menu" aria-labelledby={labelId}>
        {options.map((opt, i) => {
          const Icon = opt.icon;
          const isActive = i === activeIdx;
          return (
            <button
              key={opt.value}
              ref={isActive ? scrollActiveIntoView : null}
              type="button"
              role="menuitem"
              aria-current={isActive ? "true" : undefined}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(opt)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left",
                "transition-colors",
                isActive ? "bg-app-bg-a2" : "hover:bg-app-bg-a2",
                "outline-none",
              )}
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-app-bg-2">
                {opt.brand ? (
                  <IntegrationGlyph brand={opt.brand} size={14} />
                ) : Icon ? (
                  <Icon size={13} className="text-app-fg-3" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-app-fg-4">
                  {opt.label}
                </span>
                <span className="block truncate text-[11px] text-app-fg-2">{opt.subtitle}</span>
              </span>
              {isActive ? (
                <span className="rounded bg-app-bg-2 px-1.5 py-0.5 text-[10px] text-app-fg-2 tabular-nums">
                  ↵
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
