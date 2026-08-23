import { ShowcaseVideo } from "~/components/landing/showcase-panel";

/**
 * Hero morning-briefing tab.
 *
 * Renders Alfred's morning-briefing clip full-bleed in the showcase bezel.
 * The clip is self-contained — it has its own on-screen header (location ·
 * temp), greeting headline, "Morning Briefing" label, and the day ledger
 * animating in — so it fills the whole bezel rather than being wrapped in
 * extra chrome (that would double the header). The earlier hand-built DOM
 * mockup recreated this same content; the clip is the higher-fidelity source.
 */
export function MorningBriefingPanel({
  className,
  active,
}: {
  className?: string | undefined;
  active?: boolean | undefined;
}) {
  return (
    <ShowcaseVideo
      src="/videos/landing/morning-briefing.mp4"
      label="Alfred's morning briefing: overnight updates across Gmail, Calendar, Slack, Linear and GitHub collated into one digest with the day's meetings and key events."
      className={className}
      active={active}
      // This clip is 1440x1260 in a 1.29 box, so `object-cover object-top`
      // trims its last bullet — which the source itself already cut mid-line.
      // Fade the bottom so the ledger reads as continuing past the frame.
      fadeEdges={["bottom"]}
    />
  );
}
