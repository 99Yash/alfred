import { useCallback, useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { AppButton } from "~/components/ui/v2";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import { type MentionConnection, type MentionConnectionLookup } from "../mention-connection";
import type { MentionOption } from "../mention-options";

export function MentionPalette({
  options,
  activeIdx,
  connections,
  connectPrompt,
  onHover,
  onPick,
  onConnect,
  onBackFromConnect,
  onClose,
}: {
  options: ReadonlyArray<MentionOption>;
  activeIdx: number;
  connections: MentionConnectionLookup;
  /** Unconnected-but-connectable option picked from the list — swaps the
   * rows for an inline connect CTA instead of inserting a dead chip. */
  connectPrompt: MentionOption | null;
  onHover: (i: number) => void;
  onPick: (option: MentionOption) => void;
  /** Commit the drill-in's primary action (dismiss + provider connect flow).
   * Owned by the controller so Enter and this button share one path. */
  onConnect: () => void;
  onBackFromConnect: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click outside the palette closes it. Pointerdown beats pointerup so the
  // click never lands on whatever's underneath.
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      // SAFETY: DOM events carry an EventTarget-or-null on `target`; Node is
      // the base of every target the pointerdown can deliver here.
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
        "absolute inset-x-0 bottom-full z-20 mb-2",
        "app-elevated rounded-2xl bg-app-bg-1 p-1.5",
        "max-h-72 overflow-y-auto",
        // Materialize from the composer edge rather than fading in place:
        // scale + blur + fade anchored at origin-bottom, the palette's edge
        // nearest its trigger. Same popover language as the model tier
        // picker; `motion-safe:` degrades to an instant appear under
        // reduced motion (the global reduce block doesn't cover arbitrary
        // animations).
        "origin-bottom",
        "motion-safe:animate-[app-popover-in_180ms_cubic-bezier(0.22,1,0.36,1)]",
      )}
    >
      <p
        id={labelId}
        className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-tight text-app-fg-2 uppercase"
      >
        Mention a source
      </p>
      {connectPrompt ? (
        <ConnectPanel
          option={connectPrompt}
          onBack={onBackFromConnect}
          onConnect={onConnect}
          labelledById={labelId}
        />
      ) : (
        /* `role="menu"` rather than `role="listbox"` here is a deliberate
         * compromise: react-doctor's prefer-tag-over-role maps listbox →
         * <datalist> (no rich rows possible) and <ul role="listbox"> trips
         * no-noninteractive-element-to-interactive-role. Semantically the
         * palette is a popup the user picks one item from — `menu` /
         * `menuitem` cover that and don't conflict with either rule. */
        // The fade replays whenever this subtree remounts — i.e. on return
        // from the connect panel — so both directions of the list ↔ panel
        // swap move, not just the way in.
        <div role="menu" aria-labelledby={labelId} className="app-fade-in">
          {options.map((opt, i) => (
            <MentionRow
              key={opt.value}
              option={opt}
              index={i}
              isActive={i === activeIdx}
              connection={connections(opt.value)}
              scrollRef={i === activeIdx ? scrollActiveIntoView : null}
              onHover={onHover}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Presentation overrides for one mention-row connection state. */
interface MentionRowPresentation {
  icon?: string;
  label?: string;
  subtitle?: string;
  tag?: { srText: string; label: string; className: string };
}

/**
 * Exhaustive over `MentionConnection`, so a new state cannot ship unstyled.
 */
type RowPresentationTable = { [State in MentionConnection]: MentionRowPresentation };

/**
 * Per-state row presentation, keyed exhaustively over `MentionConnection` so
 * a new state cannot ship unstyled — adding one is a compile error here, not
 * a silently healthy-looking row. `loading` renders like a plain usable row
 * on purpose: rows stay stateless during load and never flash "Connect".
 * An integration you can't use yet sits visually behind the ones you can —
 * quiet dimming, not removal, so the catalog stays discoverable.
 */
const ROW_PRESENTATION: RowPresentationTable = {
  internal: {},
  connected: {},
  loading: {},
  connectable: {
    icon: "opacity-60",
    label: "opacity-70",
    tag: {
      srText: "Not connected",
      label: "Connect",
      className:
        "shrink-0 rounded-md bg-app-bg-2 px-1.5 py-0.5 text-[10px] font-medium text-app-fg-3",
    },
  },
  unavailable: {
    icon: "opacity-40",
    label: "opacity-50",
    subtitle: "opacity-50",
    tag: {
      srText: "Not set up yet",
      label: "Soon",
      className: "shrink-0 px-1 py-0.5 text-[10px] font-medium text-app-fg-3 opacity-60",
    },
  },
};

/** The brand glyph (or fallback icon) for a mention option. */
function OptionAvatar({
  option,
  className,
  brandSize,
  iconSize,
}: {
  option: MentionOption;
  className?: string;
  brandSize: number;
  iconSize: number;
}) {
  const Icon = option.icon;
  return (
    <span className={className}>
      {option.brand ? (
        <IntegrationGlyph brand={option.brand} size={brandSize} />
      ) : Icon ? (
        <Icon size={iconSize} className="text-app-fg-3" />
      ) : null}
    </span>
  );
}

function MentionRow({
  option,
  index,
  isActive,
  connection,
  scrollRef,
  onHover,
  onPick,
}: {
  option: MentionOption;
  index: number;
  isActive: boolean;
  connection: MentionConnection;
  scrollRef: ((el: HTMLButtonElement | null) => void) | null;
  onHover: (i: number) => void;
  onPick: (option: MentionOption) => void;
}) {
  const presentation = ROW_PRESENTATION[connection];
  return (
    <button
      ref={scrollRef ?? undefined}
      type="button"
      role="menuitem"
      aria-current={isActive ? "true" : undefined}
      onMouseEnter={() => onHover(index)}
      onClick={() => onPick(option)}
      className={cn(
        "app-press flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left",
        // Background and transform together so the app-press scale
        // interpolates instead of snapping — same row recipe as the model
        // tier picker.
        "transition-[background-color,transform]",
        isActive ? "bg-app-bg-a2" : "hover:bg-app-bg-a2",
        "outline-none",
      )}
    >
      <OptionAvatar
        option={option}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full bg-app-bg-2",
          presentation.icon,
        )}
        brandSize={14}
        iconSize={13}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn("block truncate text-[13px] font-medium text-app-fg-4", presentation.label)}
        >
          {option.label}
        </span>
        <span className={cn("block truncate text-[11px] text-app-fg-2", presentation.subtitle)}>
          {option.subtitle}
        </span>
      </span>
      {presentation.tag ? (
        <>
          <span className="sr-only">{presentation.tag.srText}</span>
          {/* Fades in rather than popping so a tag arriving when credential
           * queries settle mid-session doesn't jolt the row layout. */}
          <span className={cn("app-fade-in", presentation.tag.className)}>
            {presentation.tag.label}
          </span>
        </>
      ) : null}
      {isActive ? (
        <span className="shrink-0 rounded bg-app-bg-2 px-1.5 py-0.5 text-[10px] text-app-fg-2 tabular-nums">
          ↵
        </span>
      ) : null}
    </button>
  );
}

/**
 * The drill-in a picked unconnected integration lands on: name the fix, one
 * primary action into the provider's connect flow, and a way back. Replaces
 * the list in place so the panel never moves — spatial continuity with the
 * row the user just chose.
 */
function ConnectPanel({
  option,
  onBack,
  onConnect,
  labelledById,
}: {
  option: MentionOption;
  onBack: () => void;
  onConnect: () => void;
  labelledById: string;
}) {
  return (
    <section aria-labelledby={labelledById} className="app-fade-in px-1 pb-0.5">
      <div className="flex items-center gap-2.5 rounded-xl bg-app-bg-a2 p-2">
        <OptionAvatar
          option={option}
          className="grid size-7 shrink-0 place-items-center rounded-full bg-app-bg-1 opacity-80"
          brandSize={16}
          iconSize={15}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-app-fg-4">
            {option.label}
          </span>
          <span className="block truncate text-[11px] text-app-fg-2">{option.subtitle}</span>
        </span>
      </div>
      <p className="px-1 py-2 text-[12px] leading-5 text-app-fg-2">
        Connect {option.label} so Alfred can use this source.
      </p>
      <div className="flex items-center gap-1.5 px-1 pb-0.5">
        <AppButton variant="primary" size="sm" onClick={onConnect}>
          Connect {option.label}
        </AppButton>
        <AppButton variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-3.5 shrink-0" strokeWidth={2} />
          All sources
        </AppButton>
      </div>
    </section>
  );
}
