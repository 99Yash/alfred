import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_FAMILY } from "../fonts";

/**
 * Alfred's morning-briefing hero clip — the brand-matched replacement for the
 * borrowed dimension MP4. Same content (greeting, the day's shape, the event
 * ledger) rendered in Open Runde with Alfred's blue panel surface, animated
 * with a staggered fade-up so it plays in cleanly and loops.
 *
 * This is the proof composition: build the design once here in React, animate
 * frame-by-frame, render to MP4. To evolve it, edit the JSX/timings and
 * re-render — no video editor, and the typography is always Alfred's.
 */

// Alfred's `.morning-briefing-surface` gradient, ported from web/src/index.css.
const SURFACE_BACKGROUND =
  "radial-gradient(ellipse 60% 40% at 100% 0%, rgba(255,255,255,0.28), rgba(255,255,255,0.06) 38%, transparent 70%)," +
  "radial-gradient(ellipse 80% 50% at 0% 100%, rgba(72,103,175,0.55), transparent 70%)," +
  "linear-gradient(160deg, rgba(72,103,175,1) 0%, rgba(58,88,156,1) 55%, rgba(64,96,168,1) 100%)";

const PAD = 72;

export const MorningBriefing: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        background: SURFACE_BACKGROUND,
        fontFamily: FONT_FAMILY,
        color: "white",
        padding: PAD,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header ribbon */}
      <FadeUp delay={2}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={EYEBROW}>☀ Mumbai · 24°</span>
          <span style={STATUS_PILL}>● Synced 6:42 AM</span>
        </div>
      </FadeUp>

      {/* Greeting headline */}
      <div style={{ marginTop: 44, maxWidth: 920 }}>
        <Headline />
      </div>

      {/* Section label + divider */}
      <FadeUp delay={26}>
        <div style={{ marginTop: 52, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={LABEL_BADGE}>☀</span>
          <span style={SECTION_LABEL}>Morning Briefing</span>
        </div>
        <div style={DIVIDER} />
      </FadeUp>

      {/* Event ledger */}
      <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 22 }}>
        <FadeUp delay={32}>
          <Line>
            <Pill tone="indigo">📅 Product Roadmap Planning</Pill>
            <span style={DIM}>until 12:30, then lunch with</span>
            <Pill tone="peach">D Dana</Pill>
            <span style={DIM}>.</span>
          </Line>
        </FadeUp>
        <FadeUp delay={40}>
          <Line>
            <Pill tone="indigo">📅 Meridian on-prem call</Pill>
            <span style={DIM}>this evening.</span>
          </Line>
        </FadeUp>
        <FadeUp delay={48}>
          <Line>
            <Pill tone="rose">M Marcus</Pill>
            <span style={DIM}>flagged the checkout bug in</span>
            <Pill tone="violet"># Eng</Pill>
            <span style={DIM}>: 3 customers affected.</span>
          </Line>
        </FadeUp>
      </div>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------------------------ */
/* Headline — words fade up in two staggered lines                     */
/* ------------------------------------------------------------------ */

const Headline: React.FC = () => (
  <h1
    style={{
      margin: 0,
      fontSize: 60,
      fontWeight: 600,
      lineHeight: 1.08,
      letterSpacing: "-0.04em",
    }}
  >
    <FadeUp delay={10} inline>
      Good morning, Alex.{" "}
    </FadeUp>
    <FadeUp delay={18} inline>
      <span style={{ color: "rgba(255,255,255,0.7)" }}>
        Four meetings, but a free afternoon.
      </span>
    </FadeUp>
  </h1>
);

/* ------------------------------------------------------------------ */
/* Motion primitive — spring-driven fade + lift, gated on `delay`      */
/* ------------------------------------------------------------------ */

const FadeUp: React.FC<{ delay: number; children: ReactNode; y?: number; inline?: boolean }> = ({
  delay,
  children,
  y = 26,
  inline = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200 },
    durationInFrames: 20,
  });
  return (
    <span
      style={{
        display: inline ? "inline" : "block",
        opacity: progress,
        transform: `translateY(${(1 - progress) * y}px)`,
      }}
    >
      {children}
    </span>
  );
};

const Line: React.FC<{ children: ReactNode }> = ({ children }) => (
  <p
    style={{
      margin: 0,
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 10,
      fontSize: 28,
      lineHeight: 1.5,
    }}
  >
    {children}
  </p>
);

const PILL_TONES: Record<string, string> = {
  indigo: "rgba(111,139,229,0.40)",
  violet: "rgba(139,111,229,0.40)",
  peach: "rgba(224,161,129,0.40)",
  rose: "rgba(229,139,139,0.40)",
};

const Pill: React.FC<{ tone: keyof typeof PILL_TONES; children: ReactNode }> = ({
  tone,
  children,
}) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 12px",
      borderRadius: 8,
      fontSize: 26,
      fontWeight: 500,
      color: "white",
      background: PILL_TONES[tone],
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.25)",
    }}
  >
    {children}
  </span>
);

/* ------------------------------------------------------------------ */
/* Static style tokens                                                 */
/* ------------------------------------------------------------------ */

const EYEBROW: CSSProperties = {
  fontSize: 21,
  fontWeight: 500,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "rgba(255,255,255,0.6)",
};

const STATUS_PILL: CSSProperties = {
  fontSize: 19,
  fontWeight: 500,
  color: "rgba(255,255,255,0.9)",
  background: "rgba(255,255,255,0.12)",
  padding: "6px 16px",
  borderRadius: 999,
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.2)",
};

const SECTION_LABEL: CSSProperties = {
  fontSize: 21,
  fontWeight: 600,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "rgba(255,255,255,0.8)",
};

const LABEL_BADGE: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 34,
  height: 34,
  borderRadius: 8,
  fontSize: 18,
  background: "rgba(255,255,255,0.15)",
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.2)",
};

const DIVIDER: CSSProperties = {
  marginTop: 18,
  height: 1,
  width: "100%",
  background: "linear-gradient(90deg, rgba(255,255,255,0.35), rgba(255,255,255,0.1), transparent)",
};

const DIM: CSSProperties = { color: "rgba(255,255,255,0.85)" };
