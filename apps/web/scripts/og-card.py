#!/usr/bin/env python3
"""
Generate the social/OG card (`public/images/og-card.png`, 1200x630).

Two steps — the PNG is NOT produced by this script directly:

  1. `python3 apps/web/scripts/og-card.py`
     Emits a self-contained `og-card.html` next to this file (Open Runde + the
     Alfred mark inlined as data URIs, so it renders with zero network access).

  2. Open that HTML at a 1200x630 viewport and screenshot it to
     `public/images/og-card.png`. Any headless-Chrome path works; this card was
     rendered via the chrome-devtools MCP (`resize_page` 1200x630 →
     `take_screenshot`).

The card mirrors the login showcase panel (`src/routes/-login/showcase-panel.tsx`)
so the social unfurl matches what a signed-out visitor sees. Wired up in
`src/lib/page-meta.ts` (runtime <head>) and `index.html` (no-JS crawler baseline).
"""

import base64
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
WEB = HERE.parent
FONTS = WEB / "public" / "fonts"


def b64(path: pathlib.Path) -> str:
    return base64.b64encode(path.read_bytes()).decode()


semibold = b64(FONTS / "OpenRunde-Semibold.woff2")
medium = b64(FONTS / "OpenRunde-Medium.woff2")
logo_b64 = base64.b64encode(
    (WEB / "public" / "images" / "logo" / "alfred-logo.svg").read_bytes()
).decode()

HTML = f"""<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
@font-face {{
  font-family: 'Open Runde'; font-weight: 500;
  src: url(data:font/woff2;base64,{medium}) format('woff2');
}}
@font-face {{
  font-family: 'Open Runde'; font-weight: 600;
  src: url(data:font/woff2;base64,{semibold}) format('woff2');
}}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
html, body {{ width: 1200px; height: 630px; }}
body {{
  font-family: 'Open Runde', -apple-system, system-ui, sans-serif;
  background: #0a0a0a; color: #fff;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  position: relative; overflow: hidden;
}}
/* brand atmosphere — mirrors the login showcase wash + a top-left glow */
.glow-a {{
  position: absolute; top: -260px; left: -220px; width: 820px; height: 820px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(91,67,224,0.28) 0%, rgba(91,67,224,0) 62%);
}}
.glow-b {{
  position: absolute; top: 60px; right: -120px; width: 760px; height: 760px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(129,112,248,0.20) 0%, rgba(129,112,248,0) 60%);
}}
/* subtle violet bottom rail */
.rail {{
  position: absolute; bottom: 0; left: 0; right: 0; height: 6px;
  background: linear-gradient(90deg, #3A24B0 0%, #5B43E0 40%, #8170F8 70%, #3A24B0 100%);
  opacity: 0.9;
}}
.frame {{
  position: relative; z-index: 3; height: 100%;
  display: grid; grid-template-columns: 1fr 472px;
  align-items: center; gap: 44px; padding: 70px 72px;
}}
.brand {{ display: flex; align-items: center; gap: 14px; margin-bottom: 32px; }}
.brand img {{ width: 50px; height: 50px; border-radius: 13px; }}
.brand span {{ font-weight: 600; font-size: 28px; letter-spacing: -0.02em; }}
h1 {{
  font-weight: 600; font-size: 53px; line-height: 1.05;
  letter-spacing: -0.045em; color: #fff;
}}
.lede {{
  margin-top: 24px; font-weight: 500; font-size: 19px; line-height: 1.5;
  letter-spacing: -0.018em; color: #a3a3a3; max-width: 32ch;
}}
.lede b {{ color: #d4d4d4; font-weight: 500; }}
/* floating product surface (depth via peek card + shadow) */
.stage {{ position: relative; }}
.peek {{
  position: absolute; left: 16px; right: -16px; top: 18px; bottom: -18px;
  border-radius: 22px; background: #161618;
  border: 1px solid rgba(255,255,255,0.05); opacity: 0.55;
}}
.card {{
  position: relative; border-radius: 24px; padding: 32px 34px 34px;
  background:
    radial-gradient(120% 70% at 50% 0%, rgba(129,112,248,0.12) 0%, rgba(129,112,248,0) 55%),
    linear-gradient(180deg, #19191c 0%, #0e0e10 100%);
  background-color: #19191c;
  border: 1px solid rgba(255,255,255,0.10);
  box-shadow: 0 50px 110px -30px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.06);
}}
.card-head {{ display: flex; align-items: center; justify-content: space-between; margin-bottom: 22px; }}
.eyebrow {{ font-weight: 600; font-size: 12px; letter-spacing: 0.13em; color: #737373; text-transform: uppercase; }}
.pill {{
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px;
  background: rgba(129,112,248,0.16); border: 1px solid rgba(129,112,248,0.30);
  color: #c3b9ff; font-weight: 600; font-size: 13px;
}}
.pill svg {{ width: 13px; height: 13px; }}
.card-title {{
  font-weight: 600; font-size: 20px; line-height: 1.34; letter-spacing: -0.02em;
  color: #fafafa; margin-bottom: 22px;
}}
ul {{ list-style: none; display: flex; flex-direction: column; gap: 16px; }}
li {{ display: flex; gap: 12px; font-size: 16px; line-height: 1.42; letter-spacing: -0.01em; }}
.dot {{ width: 8px; height: 8px; border-radius: 50%; margin-top: 7px; flex: none; }}
.d1 {{ background: #8170f8; box-shadow: 0 0 10px rgba(129,112,248,0.7); }}
.d2 {{ background: #5b9dff; box-shadow: 0 0 10px rgba(91,157,255,0.6); }}
.d3 {{ background: #f5b34a; box-shadow: 0 0 10px rgba(245,179,74,0.6); }}
li p {{ color: #a3a3a3; font-weight: 500; }}
li strong {{ color: #fafafa; font-weight: 600; }}
</style>
</head>
<body>
  <div class="glow-a"></div>
  <div class="glow-b"></div>

  <div class="frame">
   <div class="copy">
    <div class="brand">
      <img src="data:image/svg+xml;base64,{logo_b64}" alt="" />
      <span>Alfred</span>
    </div>
    <h1>The all&#8209;encompassing personal assistant.</h1>
    <p class="lede">
      Email, calendar, GitHub, and the tools you work in, all in <b>one place.</b>
    </p>
   </div>

   <div class="stage">
    <div class="peek"></div>
    <div class="card">
      <div class="card-head">
        <span class="eyebrow">Friday morning · 8:02</span>
        <span class="pill">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" fill="currentColor"/><path d="M19 14l.7 1.9L21.5 16.6 19.7 17.3 19 19.2 18.3 17.3 16.5 16.6 18.3 15.9 19 14z" fill="currentColor"/></svg>
          Brief
        </span>
      </div>
      <p class="card-title">Three things need you today. Pulled from your inbox, repos, and calendar.</p>
      <ul>
        <li><span class="dot d1"></span><p><strong>Sycamore:</strong> Term sheet expires Sunday 9pm. Reply drafted. Yours to send.</p></li>
        <li><span class="dot d2"></span><p><strong>alfred/api #128:</strong> Your review has blocked the release for two days.</p></li>
        <li><span class="dot d3"></span><p><strong>Design review:</strong> Now Friday 3pm. The agenda's still empty.</p></li>
      </ul>
    </div>
   </div>
  </div>

  <div class="rail"></div>
</body>
</html>
"""

out = HERE / "og-card.html"
out.write_text(HTML)
print(f"wrote {out}")
print("next: open it at 1200x630 and screenshot -> ../public/images/og-card.png")
