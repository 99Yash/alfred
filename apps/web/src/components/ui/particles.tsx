import { useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

/**
 * Canvas-backed drifting particles for ambient background polish. Ported from
 * the forklifter project — particles spawn with random low alphas, drift slowly,
 * and gently pull toward the cursor via a per-particle magnetism factor.
 *
 * Respects `prefers-reduced-motion` — particles render once and stay still
 * instead of animating, so users with the OS toggle on still see the dots
 * without the drift loop.
 */
interface ParticlesProps {
  className?: string;
  /** How many dots to draw. Lower = subtler. Default 30. */
  quantity?: number;
  /** Lower = particles follow the mouse more aggressively. Default 50. */
  staticity?: number;
  /** Easing for mouse-follow. Default 50. */
  ease?: number;
  /** Particle color as `#rrggbb`. Caller should swap per theme. */
  color?: string;
  /** Upper bound on per-particle alpha (random 0.05..maxAlpha). Default 0.4. */
  maxAlpha?: number;
}

type Circle = {
  x: number;
  y: number;
  translateX: number;
  translateY: number;
  size: number;
  alpha: number;
  targetAlpha: number;
  dx: number;
  dy: number;
  magnetism: number;
};

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace("#", "");
  const n = parseInt(cleaned, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function Particles({
  className,
  quantity = 30,
  staticity = 50,
  ease = 50,
  color = "#ffffff",
  maxAlpha = 0.4,
}: ParticlesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rgb = hexToRgb(color);
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const circles: Circle[] = [];
    const mouse = { x: 0, y: 0 };
    const size = { w: 0, h: 0 };
    let rafId: number | null = null;

    const circleParams = (): Circle => ({
      x: Math.floor(Math.random() * size.w),
      y: Math.floor(Math.random() * size.h),
      translateX: 0,
      translateY: 0,
      size: Math.floor(Math.random() * 2) + 1,
      alpha: 0,
      targetAlpha: parseFloat((Math.random() * (maxAlpha - 0.05) + 0.05).toFixed(2)),
      dx: (Math.random() - 0.5) * 0.2,
      dy: (Math.random() - 0.5) * 0.2,
      magnetism: 0.1 + Math.random() * 4,
    });

    const drawCircle = (circle: Circle, update = false) => {
      const { x, y, translateX, translateY, size: s, alpha } = circle;
      ctx.translate(translateX, translateY);
      ctx.beginPath();
      ctx.arc(x, y, s, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(${rgb.join(", ")}, ${alpha})`;
      ctx.fill();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!update) circles.push(circle);
    };

    const clearContext = () => {
      ctx.clearRect(0, 0, size.w, size.h);
    };

    const drawParticles = () => {
      clearContext();
      for (let i = 0; i < quantity; i++) drawCircle(circleParams());
    };

    const resizeCanvas = () => {
      circles.length = 0;
      size.w = container.offsetWidth;
      size.h = container.offsetHeight;
      canvas.width = size.w * dpr;
      canvas.height = size.h * dpr;
      canvas.style.width = `${size.w}px`;
      canvas.style.height = `${size.h}px`;
      ctx.scale(dpr, dpr);
    };

    const initCanvas = () => {
      resizeCanvas();
      drawParticles();
    };

    const remap = (v: number, a1: number, b1: number, a2: number, b2: number) => {
      const r = ((v - a1) * (b2 - a2)) / (b1 - a1) + a2;
      return r > 0 ? r : 0;
    };

    const animate = () => {
      clearContext();
      circles.forEach((circle, i) => {
        const edges = [
          circle.x + circle.translateX - circle.size,
          size.w - circle.x - circle.translateX - circle.size,
          circle.y + circle.translateY - circle.size,
          size.h - circle.y - circle.translateY - circle.size,
        ];
        const closest = edges.reduce((a, b) => Math.min(a, b));
        const fade = parseFloat(remap(closest, 0, 20, 0, 1).toFixed(2));
        if (fade > 1) {
          circle.alpha = Math.min(circle.alpha + 0.02, circle.targetAlpha);
        } else {
          circle.alpha = circle.targetAlpha * fade;
        }
        circle.x += circle.dx;
        circle.y += circle.dy;
        circle.translateX +=
          (mouse.x / (staticity / circle.magnetism) - circle.translateX) / ease;
        circle.translateY +=
          (mouse.y / (staticity / circle.magnetism) - circle.translateY) / ease;
        const out =
          circle.x < -circle.size ||
          circle.x > size.w + circle.size ||
          circle.y < -circle.size ||
          circle.y > size.h + circle.size;
        if (out) {
          circles.splice(i, 1);
          drawCircle(circleParams());
        } else {
          drawCircle({ ...circle, alpha: circle.alpha }, true);
        }
      });
      rafId = window.requestAnimationFrame(animate);
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left - size.w / 2;
      const y = e.clientY - rect.top - size.h / 2;
      const inside = x < size.w / 2 && x > -size.w / 2 && y < size.h / 2 && y > -size.h / 2;
      if (inside) {
        mouse.x = x;
        mouse.y = y;
      }
    };

    initCanvas();
    if (!reducedMotion) animate();
    window.addEventListener("resize", initCanvas);
    window.addEventListener("mousemove", onMouseMove);

    return () => {
      window.removeEventListener("resize", initCanvas);
      window.removeEventListener("mousemove", onMouseMove);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [color, quantity, staticity, ease, maxAlpha]);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className={cn("pointer-events-none select-none", className)}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
