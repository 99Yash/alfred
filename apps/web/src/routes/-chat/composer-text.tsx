import { useEffect, useRef, type KeyboardEventHandler, type Ref } from "react";
import { cn } from "~/lib/utils";

/**
 * Textarea + character mirror — gives the empty-chat composer a monkeytype-like
 * typing feel without forking off the platform textarea.
 *
 * The user types into a normal `<textarea>` so IME, undo, paste, copy, spell-
 * check, etc. all work natively. We render an absolutely positioned mirror
 * directly behind it, char-by-char, where each freshly mounted span runs a
 * 140ms fade-and-settle. The native text is `color: transparent` so the mirror
 * shows through; the native caret stays visible (driven by `caret-color`).
 *
 * Metrics on the mirror MUST match the textarea exactly (font, leading,
 * letter-spacing, padding, white-space wrapping) or the caret will drift away
 * from the visible glyph.
 */
export function TextareaWithMirror({
  value,
  onChange,
  onKeyDown,
  placeholder,
  textareaRef,
}: {
  value: string;
  onChange: (next: string) => void;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  placeholder?: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
}) {
  // Refs into the two layers so we can sync mirror scroll to textarea scroll
  // when the user types past the visible area. Keeps them in lock-step.
  const internalTaRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const ta = internalTaRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    const sync = () => {
      mirror.scrollTop = ta.scrollTop;
    };
    ta.addEventListener("scroll", sync, { passive: true });
    return () => ta.removeEventListener("scroll", sync);
  }, []);

  const setTaRef = (node: HTMLTextAreaElement | null) => {
    internalTaRef.current = node;
    if (typeof textareaRef === "function") textareaRef(node);
    else if (textareaRef && "current" in textareaRef) {
      (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    }
  };

  const SHARED = cn(
    "block w-full resize-none",
    "min-h-[64px] max-h-64 px-3 pt-2 pb-1.5",
    "text-[15px] leading-7 font-medium tracking-tight",
    "whitespace-pre-wrap break-words",
  );

  return (
    <div className="relative">
      <div
        ref={mirrorRef}
        aria-hidden
        className={cn(
          SHARED,
          "pointer-events-none absolute inset-0 overflow-hidden",
          "text-vs-fg-4 select-none",
        )}
      >
        {value.length === 0 ? (
          // Empty mirror leaves the textarea placeholder visible underneath.
          <span aria-hidden>{"​"}</span>
        ) : (
          <>
            {Array.from(value).map((ch, i) => (
              // Keyed by index so each span animates exactly once when it
              // first mounts; later renders of the same index reuse the span
              // (and skip the animation), which is what we want for fast typing.
              <span key={i} className="chat-char">
                {ch === "\n" ? "\n" : ch}
              </span>
            ))}
            {/* Trailing zero-width char gives the mirror something to render
             * at the very end so its scrollHeight matches the textarea when
             * the value ends with a newline. */}
            <span aria-hidden>{"​"}</span>
          </>
        )}
      </div>
      <textarea
        ref={setTaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        aria-label="Message"
        placeholder={placeholder}
        spellCheck
        className={cn(
          SHARED,
          "relative bg-transparent text-transparent",
          "caret-vs-purple-3",
          "outline-none placeholder:text-vs-fg-2 placeholder:font-normal placeholder:tracking-normal",
          "selection:bg-vs-purple-2/40 selection:text-vs-fg-4",
        )}
      />
    </div>
  );
}
