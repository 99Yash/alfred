import { TextQuote } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppTheme } from "~/components/ui/v2";
import { cn } from "~/lib/utils";

const QUOTABLE_ATTR = "data-chat-quotable";

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
  const { resolved } = useAppTheme();
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

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
      if (e.target instanceof Node && buttonRef.current?.contains(e.target)) return;
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

  if (!anchor) return null;

  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      data-app-theme={resolved}
      style={{ left: anchor.x, top: anchor.y }}
      // Keep the selection alive through the click.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(anchor.text);
        window.getSelection()?.removeAllRanges();
        setAnchor(null);
      }}
      className={cn(
        "app fixed z-200 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3 py-1.5",
        anchor.placement === "above" && "-translate-y-full",
        "bg-app-fg-4 text-xs font-medium text-app-bg-1 shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
        "animate-[app-fade-in_120ms_ease-out] select-none motion-reduce:animate-none",
        "app-press app-focus",
      )}
    >
      <TextQuote size={13} aria-hidden />
      Ask Alfred
    </button>,
    document.body,
  );
}
