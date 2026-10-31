#!/usr/bin/env node
/**
 * Cut the Latin slice of Open Runde that every page preloads.
 *
 *   node apps/web/scripts/subset-fonts.mjs
 *
 * Inputs are the full faces in `public/fonts/OpenRunde-{Medium,Semibold}.woff2`
 * (2,512 codepoints, ~165 KB each). Outputs are `OpenRunde-*-latin.woff2`
 * (~28 KB each) next to them. Needs `uvx` (fontTools runs from a throwaway env).
 *
 * `src/index.css` declares two faces per weight: the Latin slice with
 * `LATIN_RANGES`, and the full file with the complement, so a browser fetches the
 * full file only when a page renders a character outside the slice. The script
 * prints both `unicode-range` values; paste them into `index.css` whenever
 * `LATIN_RANGES` changes. `index.html` preloads only the Latin slices.
 *
 * `LATIN_RANGES` is Google Fonts' "latin" slice plus the arrows, keyboard glyphs
 * and comparison signs the UI renders (`→`, `⌘`, `↵`, `⌥`, `⇧`, `≤`, `≥`, ...).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FONTS_DIR = fileURLToPath(new URL("../public/fonts/", import.meta.url));

const WEIGHTS = ["Medium", "Semibold"];

/** Inclusive [start, end] codepoint pairs, sorted and non-overlapping. */
const LATIN_RANGES = [
  [0x0000, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bb, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02da],
  [0x02dc, 0x02dc],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2190, 0x2199],
  [0x21b5, 0x21b5],
  [0x21e5, 0x21e5],
  [0x21e7, 0x21e7],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0x2248, 0x2248],
  [0x2260, 0x2260],
  [0x2264, 0x2265],
  [0x2303, 0x2303],
  [0x2318, 0x2318],
  [0x2325, 0x2325],
  [0x232b, 0x232b],
  [0x238b, 0x238b],
  [0x2713, 0x2713],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
];

const MAX_CODEPOINT = 0x10ffff;

function complement(ranges) {
  const out = [];
  let next = 0;

  for (const [start, end] of ranges) {
    if (start > next) out.push([next, start - 1]);
    next = end + 1;
  }

  if (next <= MAX_CODEPOINT) out.push([next, MAX_CODEPOINT]);

  return out;
}

function hex(cp) {
  return cp.toString(16).toUpperCase().padStart(4, "0");
}

function cssRange(ranges) {
  return ranges
    .map(([start, end]) => (start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`))
    .join(", ");
}

const latin = cssRange(LATIN_RANGES);

for (const weight of WEIGHTS) {
  execFileSync(
    "uvx",
    [
      "--from",
      "fonttools[woff]",
      "pyftsubset",
      `${FONTS_DIR}OpenRunde-${weight}.woff2`,
      "--flavor=woff2",
      `--output-file=${FONTS_DIR}OpenRunde-${weight}-latin.woff2`,
      `--unicodes=${latin}`,
      "--layout-features=*",
    ],
    { stdio: "inherit" },
  );
}

process.stdout.write(
  `Latin slice unicode-range:\n  ${latin};\n\nFull face unicode-range:\n  ${cssRange(complement(LATIN_RANGES))};\n`,
);
