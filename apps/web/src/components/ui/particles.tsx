import { useEffect, useRef, useState } from "react";
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

function useMousePosition() {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);
  return pos;
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
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const circlesRef = useRef<Circle[]>([]);
  const mouseRef = useRef({ x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const rafRef = useRef<number | null>(null);
  const mousePosition = useMousePosition();
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  const rgb = hexToRgb(color);

  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (canvasRef.current) {
      ctxRef.current = canvasRef.current.getContext("2d");
    }
    initCanvas();
    if (!reducedMotion) animate();
    window.addEventListener("resize", initCanvas);
    return () => {
      window.removeEventListener("resize", initCanvas);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // initCanvas / animate close over color + quantity via refs/params; we
    // remount the whole canvas on color change via the parent's `key` so this
    // mount-once effect is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onMouseMove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mousePosition.x, mousePosition.y]);

  const onMouseMove = () => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const { w, h } = sizeRef.current;
    const x = mousePosition.x - rect.left - w / 2;
    const y = mousePosition.y - rect.top - h / 2;
    const inside = x < w / 2 && x > -w / 2 && y < h / 2 && y > -h / 2;
    if (inside) {
      mouseRef.current.x = x;
      mouseRef.current.y = y;
    }
  };

  const resizeCanvas = () => {
    if (!containerRef.current || !canvasRef.current || !ctxRef.current) return;
    circlesRef.current.length = 0;
    sizeRef.current.w = containerRef.current.offsetWidth;
    sizeRef.current.h = containerRef.current.offsetHeight;
    canvasRef.current.width = sizeRef.current.w * dpr;
    canvasRef.current.height = sizeRef.current.h * dpr;
    canvasRef.current.style.width = `${sizeRef.current.w}px`;
    canvasRef.current.style.height = `${sizeRef.current.h}px`;
    ctxRef.current.scale(dpr, dpr);
  };

  const circleParams = (): Circle => ({
    x: Math.floor(Math.random() * sizeRef.current.w),
    y: Math.floor(Math.random() * sizeRef.current.h),
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
    if (!ctxRef.current) return;
    const { x, y, translateX, translateY, size, alpha } = circle;
    ctxRef.current.translate(translateX, translateY);
    ctxRef.current.beginPath();
    ctxRef.current.arc(x, y, size, 0, 2 * Math.PI);
    ctxRef.current.fillStyle = `rgba(${rgb.join(", ")}, ${alpha})`;
    ctxRef.current.fill();
    ctxRef.current.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!update) circlesRef.current.push(circle);
  };

  const clearContext = () => {
    ctxRef.current?.clearRect(0, 0, sizeRef.current.w, sizeRef.current.h);
  };

  const drawParticles = () => {
    clearContext();
    for (let i = 0; i < quantity; i++) drawCircle(circleParams());
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
    circlesRef.current.forEach((circle, i) => {
      const edges = [
        circle.x + circle.translateX - circle.size,
        sizeRef.current.w - circle.x - circle.translateX - circle.size,
        circle.y + circle.translateY - circle.size,
        sizeRef.current.h - circle.y - circle.translateY - circle.size,
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
        (mouseRef.current.x / (staticity / circle.magnetism) - circle.translateX) /
        ease;
      circle.translateY +=
        (mouseRef.current.y / (staticity / circle.magnetism) - circle.translateY) /
        ease;
      const out =
        circle.x < -circle.size ||
        circle.x > sizeRef.current.w + circle.size ||
        circle.y < -circle.size ||
        circle.y > sizeRef.current.h + circle.size;
      if (out) {
        circlesRef.current.splice(i, 1);
        drawCircle(circleParams());
      } else {
        drawCircle({ ...circle, alpha: circle.alpha }, true);
      }
    });
    rafRef.current = window.requestAnimationFrame(animate);
  };

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
