import { ShowcaseVideo } from "~/components/landing/showcase-panel";

/**
 * Hero inbox tab.
 *
 * Renders Alfred's inbox auto-tagging clip full-bleed in the showcase bezel
 * (the first ~5s of the source, where every inbound email gets an AI label —
 * action needed / fyi / marketing / done). The clip is a self-contained
 * Gmail-style list with its own chrome, so it fills the whole bezel rather
 * than being wrapped in extra chrome.
 */
export function InboxMockup({ className, active }: { className?: string; active?: boolean }) {
  return (
    <ShowcaseVideo
      src="/videos/landing/inbox-tagging.mp4"
      label="Alfred auto-labelling an inbox: every inbound email tagged as action needed, fyi, marketing, or done, with replies pre-drafted on the ones that need a response."
      className={className}
      active={active}
    />
  );
}
