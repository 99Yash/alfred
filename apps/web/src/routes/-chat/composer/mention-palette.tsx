import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AppButton } from "~/components/ui/v2";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { getIntegrationProvider } from "~/lib/integrations/integrations";
import { cn } from "~/lib/utils";
import { type MentionConnection, type MentionConnectionMap } from "../mention-connection";
import type { MentionOption } from "../mention-options";

export function MentionPalette({
  options,
  activeIdx,
  connections,
  connectPrompt,
  onHover,
  onPick,
  onBackFromConnect,
  onClose,
}: {
  options: ReadonlyArray<MentionOption>;
  activeIdx: number;
  connections: MentionConnectionMap;
  /** Unconnected-but-connectable option picked from the list — swaps the
   * rows for an inline connect CTA instead of inserting a dead chip. */
  connectPrompt: MentionOption | null;
  onHover: (i: number) => void;
  onPick: (option: MentionOption) => void;
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
      {connectPrompt ? (
        <ConnectPanel
          option={connectPrompt}
          onBack={onBackFromConnect}
          onClose={onClose}
          labelledById={labelId}
        />
      ) : (
        /* `role="menu"` rather than `role="listbox"` here is a deliberate
         * compromise: react-doctor's prefer-tag-over-role maps listbox →
         * <datalist> (no rich rows possible) and <ul role="listbox"> trips
         * no-noninteractive-element-to-interactive-role. Semantically the
         * palette is a popup the user picks one item from — `menu` /
         * `menuitem` cover that and don't conflict with either rule. */
        <div role="menu" aria-labelledby={labelId}>
          {options.map((opt, i) => (
            <MentionRow
              key={opt.value}
              option={opt}
              index={i}
              isActive={i === activeIdx}
              connection={connections.get(opt.value) ?? "internal"}
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
  const Icon = option.icon;
  const connectable = connection === "connectable";
  const unavailable = connection === "unavailable";
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
        "transition-colors",
        isActive ? "bg-app-bg-a2" : "hover:bg-app-bg-a2",
        "outline-none",
      )}
    >
      <span
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full bg-app-bg-2",
          // An integration you can't use yet sits visually behind the ones
          // you can — quiet dimming, not removal, so the catalog stays
          // discoverable and the fix stays one keystroke away.
          connectable && "opacity-60",
          unavailable && "opacity-40",
        )}
      >
        {option.brand ? (
          <IntegrationGlyph brand={option.brand} size={14} />
        ) : Icon ? (
          <Icon size={13} className="text-app-fg-3" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[13px] font-medium text-app-fg-4",
            connectable && "opacity-70",
            unavailable && "opacity-50",
          )}
        >
          {option.label}
        </span>
        <span
          className={cn("block truncate text-[11px] text-app-fg-2", unavailable && "opacity-50")}
        >
          {option.subtitle}
        </span>
      </span>
      {connectable ? (
        <>
          <span className="sr-only">Not connected</span>
          <span className="shrink-0 rounded-md bg-app-bg-2 px-1.5 py-0.5 text-[10px] font-medium text-app-fg-3">
            Connect
          </span>
        </>
      ) : null}
      {unavailable ? (
        <>
          <span className="sr-only">Not set up yet</span>
          <span className="shrink-0 px-1 py-0.5 text-[10px] font-medium text-app-fg-3 opacity-60">
            Soon
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
  onClose,
  labelledById,
}: {
  option: MentionOption;
  onBack: () => void;
  onClose: () => void;
  labelledById: string;
}) {
  const navigate = useNavigate();
  const provider = getIntegrationProvider(option.value);
  const Icon = option.icon;

  const connect = () => {
    onClose();
    if (!provider) return;
    void navigate({ to: "/integrations/$provider", params: { provider: provider.id } });
  };

  return (
    <section aria-labelledby={labelledById} className="app-fade-in px-1 pb-0.5">
      <div className="flex items-center gap-2.5 rounded-xl bg-app-bg-a2 p-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-app-bg-1 opacity-80">
          {option.brand ? (
            <IntegrationGlyph brand={option.brand} size={16} />
          ) : Icon ? (
            <Icon size={15} className="text-app-fg-3" />
          ) : null}
        </span>
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
        {provider ? (
          <AppButton variant="primary" size="sm" onClick={connect}>
            Connect {option.label}
          </AppButton>
        ) : null}
        <AppButton variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-3.5 shrink-0" strokeWidth={2} />
          All sources
        </AppButton>
      </div>
    </section>
  );
}
