import { continueRender, delayRender, staticFile } from "remotion";

/**
 * Load Alfred's brand font (Open Runde) into the Remotion render so clips are
 * typeset exactly like the product — not in dimension's Geist. `delayRender`
 * blocks frame capture until the woff2 files are parsed, so no frame renders
 * with a fallback font.
 */
const handle = delayRender("Loading Open Runde");

const medium = new FontFace(
  "Open Runde",
  `url(${staticFile("fonts/OpenRunde-Medium.woff2")}) format("woff2")`,
  { weight: "500" },
);
const semibold = new FontFace(
  "Open Runde",
  `url(${staticFile("fonts/OpenRunde-Semibold.woff2")}) format("woff2")`,
  { weight: "600" },
);

Promise.all([medium.load(), semibold.load()])
  .then((loaded) => {
    loaded.forEach((font) => document.fonts.add(font));
    continueRender(handle);
  })
  .catch(() => continueRender(handle));

export const FONT_FAMILY = '"Open Runde", system-ui, sans-serif';
