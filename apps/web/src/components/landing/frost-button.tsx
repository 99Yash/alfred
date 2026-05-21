import type { ButtonHTMLAttributes, CSSProperties, Ref } from "react";
import { cn } from "~/lib/utils";

export type FrostButtonTone = "dark" | "light";
export type FrostButtonSize = "sm" | "md" | "lg";

/**
 * Frost-bordered call-to-action button. Inherits `frost-border` for the
 * gradient hairline + inset glow, then layers:
 *   • dark-glass or light-paper fill (per `tone`)
 *   • a radial top-left specular highlight pseudo
 *   • an after-overlay for the hover wash
 *
 * Alfred is dark-first so `tone="dark"` is the default. Use `tone="light"`
 * on top of light backgrounds (e.g. a paper-textured section) — that matches
 * Dimension's original "Get Started" button recipe.
 */
export function FrostButton({
  className,
  size = "md",
  tone = "dark",
  ref,
  style,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: FrostButtonSize;
  tone?: FrostButtonTone;
  ref?: Ref<HTMLButtonElement>;
}) {
  const sizeClass =
    size === "lg"
      ? "px-5 py-2.5 text-base gap-2"
      : size === "sm"
        ? "px-3 py-1.5 text-xs gap-1"
        : "px-3.5 py-2 text-sm gap-1.5";

  const toneClass =
    tone === "light"
      ? // Dimension's original light recipe — bright fill, dark text. NB: this
        // project inverts Tailwind's gray scale (gray-950 maps to near-white),
        // so the text color is a literal hex value, not a token utility.
        cn(
          "bg-white bg-gradient-to-b from-[#eee] to-[#eee]",
          "text-[#0c0c0c]",
          "hover:to-[#eee]/70 active:to-[#eee]/90",
          "after:bg-white/[0.05] hover:after:opacity-50",
        )
      : // Dark-glass — Alfred default. Translucent dark fill + white text.
        cn(
          "bg-gradient-to-b from-white/[0.14] to-white/[0.06]",
          "text-white",
          "hover:from-white/[0.20] hover:to-white/[0.10]",
          "active:from-white/[0.10] active:to-white/[0.04]",
          "after:bg-white/[0.10] hover:after:opacity-100",
        );

  const mergedStyle: CSSProperties = {
    border: "0.5px solid transparent",
    ...style,
  };

  return (
    <button
      ref={ref}
      type="button"
      style={mergedStyle}
      className={cn(
        "frost-border press-scale select-none isolate inline-flex items-center justify-center",
        "rounded-full font-medium backdrop-blur-md",
        // after-overlay — soft hover wash
        "after:content-[''] after:absolute after:inset-0 after:rounded-[inherit]",
        "after:pointer-events-none after:opacity-0 after:transition-opacity after:duration-200",
        "active:after:opacity-0",
        "disabled:cursor-not-allowed disabled:brightness-[0.85] disabled:after:opacity-0",
        "transition duration-200",
        toneClass,
        sizeClass,
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]",
          "before:content-[''] before:absolute before:inset-0 before:rounded-[inherit]",
          tone === "light"
            ? "before:bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.6),rgba(255,255,255,0)_50%)]"
            : "before:bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.18),rgba(255,255,255,0)_55%)]",
          "before:opacity-80",
        )}
      />
      <span className="relative z-[1] flex items-center gap-[inherit]">{children}</span>
    </button>
  );
}
