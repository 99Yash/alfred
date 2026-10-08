import { ShowcaseVideo } from "~/components/landing/showcase-panel";

/** Hero meeting-prep tab: the clip (sped up ~1.4x) fills the bezel. */
export function MeetingPrepMockup({ className, active }: { className?: string; active?: boolean }) {
  return (
    <ShowcaseVideo
      src="/videos/landing/meeting.mp4"
      label="Alfred's pre-meeting brief for a 1:1 with Anika: the meeting agenda with her brief sliding in. What's on her mind, what's worth bringing up, and what to watch out for."
      className={className}
      active={active}
      // The source framing cuts content on both sides.
      fadeEdges={["left", "right"]}
    />
  );
}
