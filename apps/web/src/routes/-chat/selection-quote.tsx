import { TextQuote } from "lucide-react";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAppTheme } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { CHAT_POP } from "./motion";

const QUOTABLE_ATTR = "data-chat-quotable";

const QUOTE_PILL_ATTR = "data-quote-pill";

/** Spread on an element whose selected text can be quoted into the composer. */
export const quotableProps = { [QUOTABLE_ATTR]: "" } as const;

/** Above this gap from the viewport top, the button sits above the selection; else below. */
const MIN_TOP_GAP = 48;

interface SelectionAnchor {
  text: string;
  /** Viewport x of the selection's center. */
  x: number;
  /** Viewport y of the button's edge nearest the selection. */
  y: number;
  placement: "above" | "below";
}

/** The selection inside one quotable element, or `null`. */
function readQuotableSelection(): SelectionAnchor | null {
  const selection = window.getSelection();

  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const element = common instanceof Element ? common : common.parentElement;

  // One message only. A drag across two messages has no single source to quote.
  if (!element?.closest(`[${QUOTABLE_ATTR}]`)) return null;
  const text = selection.toString().trim();

  if (!text) return null;
  const rect = range.getBoundingClientRect();
  const placement = rect.top > MIN_TOP_GAP ? "above" : "below";

  return {
    text,
    x: rect.left + rect.width / 2,
    y: placement === "above" ? rect.top - 8 : rect.bottom + 8,
    placement,
  };
}

/**
 * A floating "Ask Alfred" button over text selected in a reply. A click hands the text to
 * `onQuote` and clears the selection. It hides while the pointer drags, on scroll, and on Escape.
 */
export function SelectionQuote({ onQuote }: { onQuote: (text: string) => void }) {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);

  useEffect(() => {
    let pointerDown = false;
    let timer: number | undefined;

    const show = () => {
      window.clearTimeout(timer);
      // After the browser settles the selection for this event.
      timer = window.setTimeout(() => setAnchor(readQuotableSelection()), 0);
    };

    const hide = () => {
      window.clearTimeout(timer);
      setAnchor(null);
    };

    const onPointerDown = (e: PointerEvent) => {
      // A click on the pill (live or leaving) is not an outside click. The
      // leaving pill is inert, so it never receives the click, but the guard
      // holds for either state.
      if (e.target instanceof Element && e.target.closest(`[${QUOTE_PILL_ATTR}]`)) return;
      pointerDown = true;
      hide();
    };

    const onPointerUp = () => {
      if (!pointerDown) return;
      pointerDown = false;
      show();
    };

    // Keyboard and touch selections end without a pointerup here.
    const onSelectionChange = () => {
      if (pointerDown) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAnchor(readQuotableSelection()), 200);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    // Capture, so the feed's own scroller counts.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  return createPortal(
    // Keyed per selection: a new selection enters fresh while the old pill leaves where it was.
    <AnimatePresence>
      {anchor ? (
        <QuotePill
          key={`${anchor.x},${anchor.y}`}
          anchor={anchor}
          onPick={() => {
            onQuote(anchor.text);
            window.getSelection()?.removeAllRanges();
            setAnchor(null);
          }}
        />
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

function QuotePill({ anchor, onPick }: { anchor: SelectionAnchor; onPick: () => void }) {
  const { resolved } = useAppTheme();
  const isPresent = useIsPresent();

  return (
    <m.button
      type="button"
      data-quote-pill=""
      data-app-theme={resolved}
      // Keep the selection alive through the click.
      onPointerDown={(e) => e.preventDefault()}
      onClick={onPick}
      style={{ left: anchor.x, top: anchor.y }}
      // The same reveal as a `Tip` pill, grown from the selection side.
      initial={{ opacity: 0, scale: 0.96, y: 2 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={CHAT_POP}
      // A leaving pill takes no second click.
      inert={!isPresent}
      className={cn(
        "fixed z-200 -translate-x-1/2",
        anchor.placement === "above" ? "origin-bottom -translate-y-full" : "origin-top",
        "app inline-flex items-center gap-1.5 rounded-full px-3 py-1.5",
        "bg-app-fg-4 text-xs font-medium text-app-bg-1 shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
        "app-press app-focus select-none",
      )}
    >
      <TextQuote size={13} aria-hidden />
      Ask Alfred
    </m.button>
  );
}
