import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { cn } from "~/lib/utils";

export function FadeInOnScroll({
  children,
  delay = 0,
  className,
  as: As = "div",
}: {
  children: ReactNode;
  delay?: number | undefined;
  className?: string | undefined;
  as?: "div" | "section" | "header" | "li" | undefined;
}) {
  const ref = useRef<HTMLElement | null>(null);

  // A callback ref fits the ref slot of every tag in `as`; an object ref fits only one tag.
  const setRef = useCallback((node: HTMLElement | null) => {
    ref.current = node;
  }, []);

  useEffect(() => {
    const el = ref.current;

    if (!el) return;

    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.classList.add("reveal-shown");
          obs.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -10% 0px" },
    );

    obs.observe(el);

    return () => obs.disconnect();
  }, []);

  const style: CSSProperties = delay > 0 ? { transitionDelay: `${delay}ms` } : {};

  return (
    <As ref={setRef} className={cn("reveal-on-scroll", className)} style={style}>
      {children}
    </As>
  );
}
