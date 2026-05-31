import { ShowcaseVideo } from "~/components/landing/showcase-panel";

/**
 * Hero meeting-prep tab.
 *
 * Renders Alfred's meeting-prep clip full-bleed in the showcase bezel — the
 * agenda for an upcoming call with the guest's brief (what's on her mind /
 * worth bringing up / heads up) sliding in over it. The clip is the
 * meeting-prep segment of the source, trimmed and sped up ~1.4x so the
 * reveal is snappy. Self-contained chrome, so it fills the whole bezel.
 */
export function MeetingPrepMockup({ className, active }: { className?: string; active?: boolean }) {
  return (
    <ShowcaseVideo
      src="/videos/landing/meeting.mp4"
      label="Alfred's pre-meeting brief for a 1:1 with Anika: the meeting agenda with her brief sliding in — what's on her mind, what's worth bringing up, and what to watch out for."
      className={className}
      active={active}
    />
  );
}
