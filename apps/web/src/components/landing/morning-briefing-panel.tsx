import { ShowcaseVideo } from "~/components/landing/showcase-panel";

/** Hero briefing tab: the self-contained clip fills the bezel, with no extra chrome. */
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
      // `object-top` in the 1.29 box trims the last bullet, already cut in the source; fade it.
      fadeEdges={["bottom"]}
    />
  );
}
