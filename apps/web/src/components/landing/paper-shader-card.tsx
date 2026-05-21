import {
  FlutedGlass,
  Metaballs,
  MeshGradient,
  LiquidMetal,
  Warp,
} from "@paper-design/shaders-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "~/lib/utils";

export type ShaderVariant = "metaballs" | "mesh" | "fluted" | "liquid" | "warp";

interface PaperShaderCardProps {
  children?: ReactNode;
  variant?: ShaderVariant;
  /** Override the shader's color palette. Defaults are tuned per-variant. */
  colors?: string[];
  className?: string;
  /** Inline style on the outer card wrapper. */
  style?: CSSProperties;
  speed?: number;
}

/**
 * Card with an animated paper-shader background. Wraps content in a rounded
 * surface; the shader canvas sits at z-0, content at z-10.
 *
 * Five variants matching the spirit of Dimension's feature cards:
 *   - metaballs  — organic blobs (best general-purpose "alive" background)
 *   - mesh       — smooth color-field
 *   - fluted     — vertical ribbed glass (the famous /sandbox/fluted-glass)
 *   - liquid     — metallic ripples
 *   - warp       — slow flowing waves
 */
export function PaperShaderCard({
  children,
  variant = "metaballs",
  colors,
  className,
  style,
  speed = 0.4,
}: PaperShaderCardProps) {
  return (
    <div
      className={cn(
        "relative isolate overflow-hidden rounded-[32px]",
        // hairline ring so the card edge reads even on a dark page
        "ring-1 ring-inset ring-white/10",
        className,
      )}
      style={style}
    >
      <div className="absolute inset-0 -z-10" aria-hidden>
        <ShaderForVariant variant={variant} colors={colors} speed={speed} />
      </div>
      <div className="relative z-10 h-full w-full">{children}</div>
    </div>
  );
}

function ShaderForVariant({
  variant,
  colors,
  speed,
}: {
  variant: ShaderVariant;
  colors?: string[];
  speed: number;
}) {
  const full = { width: "100%", height: "100%" } as const;

  switch (variant) {
    case "mesh":
      return (
        <MeshGradient
          style={full}
          colors={colors ?? ["#3d2a72", "#6b62f2", "#0b1224", "#1a2540"]}
          distortion={1.1}
          swirl={0.6}
          speed={speed}
        />
      );

    case "fluted":
      return (
        <FlutedGlass
          style={full}
          // FlutedGlass distorts whatever's behind it — pair with a colored
          // wrapper background. Defaults give a soft ribbed glass look.
          size={0.35}
          angle={0}
          blur={0.4}
          shape="lines"
          distortion={0.4}
          distortionShape="prism"
          edges={0.3}
          shadows={0.2}
          highlights={0.15}
          colorShadow="#000000"
          colorHighlight="#ffffff"
        />
      );

    case "liquid":
      return (
        <LiquidMetal
          style={full}
          colorBack="#0b1224"
          colorTint={colors?.[0] ?? "#7aa8ff"}
          repetition={3.5}
          softness={0.6}
          shiftRed={0.05}
          shiftBlue={0.1}
          distortion={0.4}
          contour={0.5}
          shape="circle"
          offsetX={0}
          offsetY={0}
          speed={speed}
        />
      );

    case "warp":
      return (
        <Warp
          style={full}
          colors={colors ?? ["#1a0a2e", "#6b62f2", "#3d2a72"]}
          proportion={0.5}
          softness={1}
          distortion={0.4}
          swirl={0.3}
          swirlIterations={5}
          speed={speed}
        />
      );

    case "metaballs":
    default:
      return (
        <Metaballs
          style={full}
          colors={colors ?? ["#0b1224", "#5d44df", "#7aa8ff"]}
          count={6}
          size={0.5}
          speed={speed}
        />
      );
  }
}
