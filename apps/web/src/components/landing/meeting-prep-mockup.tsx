import { ShowcaseImage } from "~/components/landing/showcase-panel";

/**
 * Hero meeting-prep tab.
 *
 * Renders Alfred's pre-meeting brief still full-bleed in the showcase bezel —
 * a "Catch Up" card summarising where the guest left off, plus a floating
 * brief (what's on her mind / worth bringing up / heads up). No clip exists
 * for this tab yet, so it's a static image (1.3:1, matches the bezel). The
 * content mirrors the same Anika scenario the other tabs reference.
 */
export function MeetingPrepMockup({ className }: { className?: string }) {
  return (
    <ShowcaseImage
      src="/images/landing/meeting-prep.png"
      label="Alfred's pre-meeting brief for a 1:1 with Anika: a Catch Up card summarising where she left off, plus what's on her mind, what's worth bringing up, and what to watch out for."
      className={className}
    />
  );
}
