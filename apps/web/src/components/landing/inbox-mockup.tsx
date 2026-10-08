import { ShowcaseVideo } from "~/components/landing/showcase-panel";

/** Hero inbox tab: the auto-tagging clip fills the bezel. */
export function InboxMockup({ className, active }: { className?: string; active?: boolean }) {
  return (
    <ShowcaseVideo
      src="/videos/landing/inbox-tagging.mp4"
      label="Alfred auto-labelling an inbox: every inbound email tagged as action needed, fyi, marketing, or done, with replies pre-drafted on the ones that need a response."
      className={className}
      active={active}
      // The clip is a crop: subjects run off the right edge mid-word.
      fadeEdges={["right"]}
    />
  );
}
