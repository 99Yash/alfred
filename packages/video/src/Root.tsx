import { Composition } from "remotion";
import { MorningBriefing } from "./compositions/MorningBriefing";

const FPS = 30;
const DURATION_SECONDS = 6.5;

/**
 * Registered compositions. Each renders to its own MP4 via
 * `pnpm render <id> out/<name>.mp4`. Dimensions are 1.29:1 to match the
 * landing hero bezel (`aspect-[1.29/1]`), so a rendered clip drops straight
 * into HeroShowcase.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="MorningBriefing"
      component={MorningBriefing}
      durationInFrames={Math.round(FPS * DURATION_SECONDS)}
      fps={FPS}
      width={1548}
      height={1200}
    />
  );
};
