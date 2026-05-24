import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { cn } from "~/lib/utils";

export function FadeInOnScroll({
  children,
  delay = 0,
  className,
  as: As = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: "div" | "section" | "header" | "li";
}) {
  const ref = useRef<HTMLElement | null>(null);

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

  const style: CSSProperties =
    delay > 0 ? { transitionDelay: `${delay}ms` } : {};

  return (
    <As
      ref={ref as never}
      className={cn("reveal-on-scroll", className)}
      style={style}
    >
      {children}
    </As>
  );
}
