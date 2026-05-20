#!/usr/bin/env python3
"""Transform dimension SVG dump into clean per-brand inner-SVG strings."""
import json
import re
import sys
from pathlib import Path

src = json.loads(Path("/Users/yash/Developer/self/alfred/.tmp/dimension-svgs.json").read_text())

SLUG_BY_NAME = {
    "Gmail": "gmail",
    "Google Calendar": "google_calendar",
    "Google Drive": "google_drive",
    "Google Docs": "google_docs",
    "Google Sheets": "google_sheets",
    "Google Slides": "google_slides",
    "GitHub": "github",
    "Linear": "linear",
    "Slack": "slack",
}

# Background frame gradients dimension uses on every tile — strip these references so
# the glyph paints in full color regardless of the host tile's background.
BG_LINEAR_NAMED_RE = re.compile(
    r'<linearGradient id="paint0_linear_[^"]+"[^>]*>\s*<stop stop-color="white"></stop>\s*<stop offset="1" stop-color="#D9D9D9"></stop>\s*</linearGradient>'
)
# Same gradient but dimension also emits it with a bare placeholder name (Calendar)
BG_LINEAR_BARE_RE = re.compile(
    r'<linearGradient id="«[^»]+»"[^>]*>\s*<stop stop-color="white"></stop>\s*<stop offset="1" stop-color="#D9D9D9"></stop>\s*</linearGradient>'
)
RADIAL_BG_RE = re.compile(
    r'<radialGradient id="[^"]*paint0_radial_[^"]+"[^>]*>.*?</radialGradient>',
    re.DOTALL,
)


def transform(name: str, svg: str) -> str:
    # 1. Drop the outer <svg ...> ... </svg>, keep inner content
    inner = re.sub(r'^<svg [^>]*>', '', svg)
    inner = re.sub(r'</svg>$', '', inner)

    # 2. Strip dimension background gradients BEFORE id-substitution so we match
    # the original named gradients regardless of placeholder churn.
    inner = BG_LINEAR_NAMED_RE.sub('', inner)
    inner = BG_LINEAR_BARE_RE.sub('', inner)
    inner = RADIAL_BG_RE.sub('', inner)

    # 3. Drop tile background rects.
    inner = re.sub(r'<rect width="50(?:\.0006)?" height="49?\.?9?9?8?6?\d*" fill="#171717"></rect>', '', inner)
    inner = re.sub(r'<rect width="50(?:\.0006)?" height="49?\.?9?9?8?6?\d*" fill="url\(#[^)]+\)"></rect>', '', inner)

    # 4. For brands whose glyph fill is the dimension-style white-on-dark gradient
    # (GitHub octocat, Linear mark), swap the fill to currentColor so we can
    # control brand color from the React component.
    if name in ("GitHub", "Linear"):
        inner = re.sub(
            r'fill="url\(#paint1_linear_[^)]+\)"',
            'fill="currentColor"',
            inner,
        )
        # Drop the now-orphan gradient + drop-shadow filters (designed for dark
        # backdrop; subtle white inner highlight is invisible on a light tile and
        # adds nothing on a frost tile). Removing them keeps the SVG light.
        inner = re.sub(
            r'<filter id="filter0_ddddi_[^"]+"[^>]*>.*?</filter>',
            '',
            inner,
            flags=re.DOTALL,
        )
        inner = re.sub(r'<g filter="url\(#filter0_ddddi_[^)]+\)">', '<g>', inner)
        inner = re.sub(
            r'<linearGradient id="paint1_linear_[^"]+"[^>]*>.*?</linearGradient>',
            '',
            inner,
            flags=re.DOTALL,
        )

    # 5. Replace ALL dimension runtime + static IDs with __UID__ placeholder.
    # Pattern 1: «rXXX» React placeholders (shared across the SVG).
    # Pattern 2: bare numeric IDs like 16327_4126 used in Linear's filter results.
    placeholder_map = {}
    def sub_token(match):
        tok = match.group(0)
        if tok not in placeholder_map:
            placeholder_map[tok] = f"__UID{len(placeholder_map)}__"
        return placeholder_map[tok]
    inner = re.sub(r'«[^»]+»', sub_token, inner)
    # Collapse Linear's static '_16327_4126' tail into the shared UID — these
    # appear on filter sub-results that don't need uniqueness across mounts but
    # do across multiple Linear instances on the same page.
    inner = re.sub(r'_16327_4126', '___UID0__', inner)

    # 6. Clean up classes that referenced dimension's positioning.
    inner = re.sub(r' class="absolute[^"]*"', '', inner)

    # 7. Drop empty <clipPath> defs and the clip-path attributes that reference
    # them. Dimension uses these to round the tile corners; we wrap the glyph
    # in our own rounded tile, and an empty clipPath clips the whole glyph to
    # nothing (invisible).
    inner = re.sub(r'<clipPath id="clip0_[^"]+"></clipPath>', '', inner)
    inner = re.sub(r' clip-path="url\(#clip0_[^)]+\)"', '', inner)

    # 8. Collapse empty <defs></defs>
    inner = re.sub(r'<defs>\s*</defs>', '', inner)
    # 9. Collapse empty wrapper groups left over from filter / clip removal.
    inner = re.sub(r'<g>\s*<g>', '<g>', inner)
    inner = re.sub(r'</g>\s*</g>', '</g>', inner)

    return inner.strip()


out = {SLUG_BY_NAME[name]: transform(name, svg) for name, svg in src.items() if name in SLUG_BY_NAME}
Path("/Users/yash/Developer/self/alfred/.tmp/brand-svgs.json").write_text(json.dumps(out, indent=2))
print(f"Wrote {len(out)} brand SVGs.")
for slug, inner in out.items():
    print(f"  {slug}: {len(inner)} chars")
