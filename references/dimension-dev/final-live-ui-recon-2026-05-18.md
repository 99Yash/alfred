# Dimension.dev final live UI recon — 2026-05-18

Captured on 2026-05-18 between 10:10 and 10:16 IST, with Dimension still live ahead of its announced May 20, 2026 shutdown.

This is the preservation layer for the last pass. It complements:

- [`NOTES.md`](./NOTES.md) — route-level UI archive
- [`tokens.md`](./tokens.md) — computed design tokens and component styles
- [`chat-anatomy.md`](./chat-anatomy.md) — chat/run/tool surface anatomy
- [`alfred-replication-map.md`](./alfred-replication-map.md) — translation into Alfred's current codebase

The evidence artifacts for this pass live in [`_live/2026-05-18-fresh/`](./_live/2026-05-18-fresh/).

## Evidence index

Dimension:

- [`dimension-chat-new-viewport.png`](./_live/2026-05-18-fresh/dimension-chat-new-viewport.png) — fresh `/chat` landing viewport.
- [`dimension-chat-new-a11y.txt`](./_live/2026-05-18-fresh/dimension-chat-new-a11y.txt) — verbose accessibility tree for `/chat`.
- [`dimension-thread-viewport.png`](./_live/2026-05-18-fresh/dimension-thread-viewport.png) — active thread viewport for `Gmail Draft Automation Test`.
- [`dimension-thread-a11y.txt`](./_live/2026-05-18-fresh/dimension-thread-a11y.txt) — verbose accessibility tree for that thread.
- [`partly_cloudy.mp4`](./_live/2026-05-18-fresh/partly_cloudy.mp4) — weather/rail background video requested by `/chat`.
- [`sunny.mp4`](./_live/2026-05-18-fresh/sunny.mp4) — alternate weather/rail background video requested during the same load.

Alfred localhost:

- [`alfred-local-home-viewport.png`](./_live/2026-05-18-fresh/alfred-local-home-viewport.png) + [`alfred-local-home-a11y.txt`](./_live/2026-05-18-fresh/alfred-local-home-a11y.txt) — initial logged-out capture, before `localhost:3001` was started.
- [`alfred-local-home-auth-viewport.png`](./_live/2026-05-18-fresh/alfred-local-home-auth-viewport.png) + [`alfred-local-home-auth-a11y.txt`](./_live/2026-05-18-fresh/alfred-local-home-auth-a11y.txt) — authenticated light-mode capture after starting the server.
- [`alfred-local-home-auth-dark-viewport.png`](./_live/2026-05-18-fresh/alfred-local-home-auth-dark-viewport.png) + [`alfred-local-home-auth-dark-a11y.txt`](./_live/2026-05-18-fresh/alfred-local-home-auth-dark-a11y.txt) — authenticated dark-mode comparison capture.
- [`alfred-local-mention-menu-dark.png`](./_live/2026-05-18-fresh/alfred-local-mention-menu-dark.png) + [`alfred-local-mention-menu-dark-a11y.txt`](./_live/2026-05-18-fresh/alfred-local-mention-menu-dark-a11y.txt) — local mention picker state.

## Live build identity

Dimension `/chat` reported:

- Page title: `New Chat - Dimension`
- URL: `https://dimension.dev/chat`
- Next page: `/chat/[[...threadId]]`
- Next build id: `2Yg6GmRb0YtGO-YJVw6mf`
- Deployment query on assets: `dpl_HfumqwUvw2j9zVXSutQ6y2HiZDC4`
- HTML class: `dark`
- Body class: `font-sans antialiased __variable_4c40f6 __variable_0d7163 __variable_246ccd __variable_f367f3`
- Body font: `"DM Sans", "DM Sans Fallback", ui-sans-serif, system-ui, sans-serif`
- Viewport captured: `1920x912`, DPR `1`

The active thread pass reported:

- Page title: `Gmail Draft Automation Test - Dimension`
- URL: `https://dimension.dev/chat/019e38f4-ea3d-71e1-a642-42d0a204005c`
- Same build id and deployment asset query as above.

## Source map status

I rechecked the live chunks surfaced by the current DOM and network panel. Source maps still are not exposed.

| Chunk | JS | Size | `sourceMappingURL` | `.map` |
| --- | ---: | ---: | ---: | ---: |
| `webpack-2554e26beb3ae227.js` | 200 | 31 KB | no | 404 |
| `framework-823a3e3d20481748.js` | 200 | 178 KB | no | 404 |
| `main-4c18076854e419b0.js` | 200 | 129 KB | no | 404 |
| `pages/_app-5a8ede7d02de660a.js` | 200 | 1028 KB | no | 404 |
| `pages/chat/[[...threadId]]-646722aa66fe6b92.js` | 200 | 250 KB | no | 404 |
| `pages/integrations-b953caf1b4f9fd15.js` | 200 | 5 KB | no | 404 |
| `pages/workflows-feba75c8bcfae548.js` | 200 | 11 KB | no | 404 |
| `pages/skills-f90cf3b49f8dfe7d.js` | 200 | 9 KB | no | 404 |
| `pages/library/[[...artifactId]]-6c3597964c40093e.js` | 200 | 33 KB | no | 404 |
| `pages/settings-9d8ce8313ee95b73.js` | 200 | 119 KB | no | 404 |

Conclusion: reconstruction should continue to rely on screenshots, accessibility trees, DOM class names, computed styles, network procedure names, and extracted tokens. Do not plan around recovering readable source from maps.

## Live network inventory

The fresh `/chat` load produced the clearest current network inventory.

Core app delivery:

- `GET /chat`
- `GET /_next/static/css/3185dab9b954338e.css`
- `GET /_next/static/css/3864b451a61e4546.css`
- Runtime chunks: `webpack`, `framework`, `main`, `_app`, many shared chunks, `pages/chat/[[...threadId]]`.
- Prefetched page chunks: workflows, settings, library, skills, integrations.
- Prefetched Next data: `/chat.json`, `/integrations.json`, `/workflows.json`, `/skills.json`, `/library.json`, `/settings.json`, and thread JSON for the recent-chat sidebar rows.

Authenticated product calls:

- `GET /trpc/auth.getLoggedInUser`
- `POST /trpc/socket.genToken`
- `GET /trpc/stripeBilling.getCurrentSubscription`
- `GET /trpc/customIntegration.getAvailable`
- `GET /trpc/customIntegration.getConnectionStatuses`
- `GET /trpc/integration.checkGoogleScopesComplete`
- `GET /trpc/todo.getAllActive`
- `GET /trpc/todoCategory.getAll`
- `GET /trpc/morningBriefing.getToday`
- `POST /trpc/atSearch.warmIntegrationNamespaces`
- `POST /trpc/search.warmUserNamespace`
- `POST /trpc/replicache.pull`
- `POST /trpc/user.detectLocation`
- `POST /trpc/user.refreshWeather`

Realtime and third-party:

- Ably token request and websocket/transport initialization via `socket.genToken`.
- PostHog EU config, flags, and event ingestion.
- Delve cookie/geo scripts.
- Google Identity script.
- Font Awesome CSS.
- `cdn.tailwindcss.com` prefetch attempted and failed DNS resolution during this capture; the page still rendered, so it is not critical for the app shell.

Visual media:

- `GET /videos/sunny.mp4` (`323,719` bytes)
- `GET /videos/partly_cloudy.mp4` (`623,046` bytes)

Both videos are now preserved in the evidence folder because they are central to the right-rail feel.

## Dimension design tokens confirmed live

The live extraction agrees with [`tokens.md`](./tokens.md).

Core dark tokens:

```css
html.dark
body {
  font-family: "DM Sans", "DM Sans Fallback", ui-sans-serif, system-ui, sans-serif;
  font-size: 16px;
  line-height: 24px;
  color: rgb(237, 237, 237);
  background-color: rgb(12, 12, 12);
}

:root {
  --radius: 0.5rem;
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  --border: 217.2 32.6% 17.5%;
  --frost-gradient: linear-gradient(to bottom right,
    rgba(255 255 255 / 1) 0%,
    rgba(16 16 16 / 0.2) 42%,
    rgba(16 16 16 / 0.2) 62%,
    rgba(255 255 255 / 1) 100%);
}
```

Key gray stops from the live page:

| Token | Value |
| --- | --- |
| `--gray-25` | `16 16 16` |
| `--gray-50` | `28 28 28` |
| `--gray-100` | `35 35 35` |
| `--gray-200` | `40 40 40` |
| `--gray-700` | `112 112 112` |
| `--gray-800` | `160 160 160` |
| `--gray-900` | `209 209 209` |
| `--gray-950` | `237 237 237` |

Key purple stops:

| Token | Value |
| --- | --- |
| `--purple-50` | `34 27 75` |
| `--purple-100` | `55 45 130` |
| `--purple-500` | `107 98 242` |
| `--purple-600` | `128 129 249` |
| `--purple-950` | `238 241 255` |

The live body also exposes `--desktop-title-bar-height`, safe-area tokens, and `--keyboard-height`, preserving the earlier conclusion that the web app was designed to sit inside native/mobile wrappers too.

## Dimension `/chat` landing anatomy

The captured `/chat` landing is the strongest reference for Alfred's near-term home/chat surface.

### Overall frame

- A shutdown banner occupies the top `36px`.
- The app body below is a three-column frame:
  - Left sidebar: visually `240px` wide, with nav rows inset to `220px`.
  - Main work area: centered composer column.
  - Right quick-access rail: `365px` wide at `1920px` viewport, inset `9px` from the right edge.
- Outer frame uses black/near-black surfaces with thin borders; the center work area is intentionally sparse.
- Body background is `rgb(12, 12, 12)`, while the neutral token `gray-25` is `rgb(16,16,16)`.

### Left sidebar

Order and affordances:

1. Avatar / profile button and collapse toggle.
2. `New Chat` with shortcut `⇧ O`.
3. `Search` with `⌘ K`.
4. `Integrations`.
5. `Workflows`.
6. `Skills`.
7. `Library`.
8. Referral banner.
9. Recent thread list.
10. `Settings` pinned at bottom.

Computed row shape:

- Nav/thread row width: `220px`.
- Row height: `40px`.
- Padding: `10px 10px 10px 12px`, or `10px 6px 10px 12px` for recent threads with kebab affordance.
- Radius: `12px` on the row wrapper.
- Kebab buttons: `28x28`, radius `8px`, mostly transparent until hover/focus.
- Text color on the captured active/dark rows: `rgb(237,237,237)` for labels, `rgb(160,160,160)` for lower-priority controls.

Important difference from Alfred: Dimension treats `Integrations`, `Workflows`, `Skills`, and `Library` as the four active product pillars. Alfred currently marks three of those as "soon" and keeps `Memory`/`Notes` in the main group.

### Center landing

Visible copy:

- Date: `Monday, May 18th`.
- Greeting: `Good Morning, Yash Gourav`.
- Composer placeholder: `Type and press enter to start chatting...`.

Placement:

- Greeting block is vertically centered above the composer, not at page top.
- Composer visual width is about `688px` including outer wrapper; inner ProseMirror editor is `652px`.
- A `Connect Your Tools` row is attached below the composer, visually part of the same object but separated by the upper composer's black field.
- Upgrade card is a bottom-centered rail using the same weather video surface.

Composer details:

- Editor is ProseMirror/Tiptap, not a textarea.
- Editor class includes `tiptap ProseMirror tiptap-minimum-input w-full p-2 focus-visible:outline-none text-sm max-h-[320px] overflow-auto min-h-[50px]`.
- The bottom control row contains:
  - `+` tool button, `32x32`, rounded full.
  - `Auto` neumorphic toggle, `72x32`, radius `10px`, `backdrop-filter: blur(4px)`, gradient `#0f0f0f -> #1e1e1e`, purple glow when on.
  - Model picker button, `108x30`, gradient `#0C0C0C -> #151515`, inset shadow, label `Dimension`.
  - Mic button.
  - Send button, `32x32`, bright gray vertical gradient.
- Composer send is disabled/quiet until text exists.
- The attached `Connect Your Tools` row has `rounded-b-2xl`, `px-4 pb-3`, `-mt-1`, and provider icon chips on the right.

### Right quick-access rail

This is the biggest fidelity gap to close in Alfred.

Dimension's right rail is not just a card stack. It is an immersive surface:

- Full-height `video` background: `partly_cloudy.mp4`.
- Video class: `absolute inset-0 h-full w-full object-cover pointer-events-none select-none transition-opacity duration-1000 ease-in-out opacity-100`.
- Rail surface radius: `24px` on the top-level panel in the screenshot.
- Text is white over the video, with dividers and translucent controls.
- Top copy: `Bhubaneswar 29°`.
- Primary mode title: `To Do`.
- Top-right tab group: black translucent pill (`bg-black/20`, radius `16px`) with three icon tabs.
- To-do filter: `All` tab plus edit pencil.
- Inline todo composer placeholder: `Add new to do`.
- Suggestions section: uppercase `SUGGESTIONS`, centered empty state icon, `No Suggestions`, then helper copy.

The rail is visually closer to a native widget than to a web sidebar. The weather video is doing real brand work: it breaks the monochrome app shell, gives the product a "daily assistant" mood, and makes the right rail feel alive.

### Upgrade card

The upgrade card is not a normal dark card:

- It also uses `partly_cloudy.mp4`, cropped to a shallow banner.
- Width: `654px`, height around `73px` in this capture.
- Radius: `24px`.
- CTA `Upgrade Plan` is a bright frosted pill: radius `9999px`, gradient `rgba(255,255,255,.8) -> #eee`, black text.

Even if Alfred does not need billing, this banner is a useful pattern for high-value proactive prompts or setup nudges: a live media surface plus one plain CTA.

## Dimension active thread anatomy

The active thread capture preserves the "Auto off / no approval gate" test state.

Observed thread details:

- Top bar title: `Gmail Draft Automation Test`.
- `Share` button in the top-right, radius `9999px`, `rgba(255,255,255,0.05)` background.
- The active conversation does not show the weather right rail; the main chat pane uses the full width after sidebar.
- The bottom composer has a ghost follow-up suggestion: `go ahead and save it` with a small `Tab` keycap.
- The composer `Auto` toggle is off in this screenshot, but the label remains `Auto`; only the pressed/knob state changes.

Human-in-loop finding:

- Dimension explicitly stated in the assistant response that it does not currently render a separate approve-before-send gate.
- It also stated it does not have a skill proposal/approval UI; memory facts save immediately when the memory tool is called.
- Therefore Alfred's manual review / approval surface should be treated as an Alfred safety improvement, not a Dimension clone detail.

This matters for UI replication: Dimension's "Auto" control is a mode/permission signal, but not a full approval queue. Alfred can keep the more explicit manual-review model, but visually it should still borrow the compactness of Dimension's `Auto` control and thread composer.

## Alfred localhost comparison

### Capture setup

The Alfred UI comparison was captured from `http://localhost:3000/`. The first `localhost:3000` capture showed only the logged-out health screen because its backend dependency, `localhost:3001`, was down:

- Page: `Alfred`
- Copy: `Server: not reachable`
- Screenshot: [`alfred-local-home-viewport.png`](./_live/2026-05-18-fresh/alfred-local-home-viewport.png)

I started `pnpm dev:server`; the API server came up on `http://0.0.0.0:3001`, then I reloaded the web UI at `http://localhost:3000/` and captured the authenticated app. I stopped the API server after the comparison pass; shutdown logged an existing SIGINT/Elysia `app.stop()` warning after the server had already been torn down.

### Alfred dark tokens

Alfred dark mode currently reports:

```css
html.dark
body {
  font-family: "Open Runde", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: oklch(0.96 0.005 95);
  background: oklch(0.155 0.005 280);
}

:root.dark {
  --background: oklch(0.155 0.005 280);
  --foreground: oklch(0.96 0.005 95);
  --card: oklch(0.185 0.005 280);
  --muted: oklch(0.23 0.005 280);
  --muted-foreground: oklch(0.66 0.01 280);
  --accent: oklch(0.255 0.005 280);
  --border: oklch(0.275 0.005 280);
  --radius: 0.625rem;
}
```

Alfred is close in spirit but warmer, more editorial, and more component-card based.

### What Alfred already matches

- Three-pane app shell exists: left sidebar, central composer, optional right rail.
- Left sidebar can collapse and supports a mobile drawer.
- Composer landing is centered with a date and personalized greeting.
- Composer has mention, approval/mode, semantic model, mic, and send controls.
- `@` mention menu exists and supports filtering/keyboard insertion.
- Right rail slot exists.
- Local dark mode is already near-black enough to carry a Dimension-inspired surface.

### Biggest gaps

1. Right rail fidelity:
   - Dimension uses a living weather/video panel with tab modes and high contrast white-on-blue content.
   - Alfred uses a plain dark sidebar with static status cards.
   - The current Alfred rail feels like an admin dashboard; Dimension's rail feels like a daily assistant.

2. Product pillars:
   - Dimension foregrounds `Integrations`, `Workflows`, `Skills`, `Library`.
   - Alfred foregrounds `Skills`, `Memory`, `Notes`, while `Workflows`, `Integrations`, and `Library` are disabled.
   - For a Dimension-faithful pass, promote the four product pillars and demote `Memory`/`Notes` to a secondary group once the routes exist.

3. Typography:
   - Dimension's app shell is almost entirely DM Sans with restrained 16/14/12px sizing.
   - Alfred uses a large Newsreader serif greeting. It is distinctive, but it makes the home screen more editorial and less Dimension-like.
   - If the immediate goal is "pristine Dimension inspiration," shrink the greeting and consider making the primary app surface sans-first. Keep the serif only if we consciously want Alfred's own flavor.

4. Composer material:
   - Dimension's composer is a black, inset, frosted/neumorphic control with a rich-text editor and a separate connected-tools row.
   - Alfred's composer is polished but larger, card-like, and has a prominent manual-review explanation strip inside the control.
   - The manual-review concept is good; the visual treatment should become more compact and less explanatory once users understand the mode.

5. Mention menu:
   - Alfred's mention menu is functionally close.
   - Dimension's menu is narrower (`19rem`), more frosted, and each row is exactly `44px` with `28px` icon tiles and connected provider SVGs.
   - Alfred should keep the keyboard behavior but tighten the surface, move it closer to the composer trigger, and eventually insert non-editable mention tokens instead of plain text.

6. Chat thread surface:
   - Dimension's thread capture shows the bottom composer, `Tab` follow-up hint, assistant prose/table styling, and no right rail.
   - Alfred does not yet have the m13 chat thread route; this remains the highest-value missing UI surface.

7. Visual assets:
   - Dimension's rail depends on video media; Alfred currently has no comparable visual asset.
   - We can use generated or app-owned weather/mood loops later, but the layout should assume a media-backed rail.

## Implementation implications for Alfred

Short-term build order should stay aligned with [`alfred-replication-map.md`](./alfred-replication-map.md), with one adjustment: the right rail deserves earlier attention because the final live `/chat` pass shows it is a major part of Dimension's perceived quality, not an accessory.

Recommended next UI pass:

1. Build a `QuickAccessRail` that can render Tasks / Emails / Meetings tabs over a media-backed or gradient-backed panel. Use the preserved `partly_cloudy.mp4` only as reference; do not ship Dimension's asset.
2. Tighten `AppShell` nav toward Dimension's order. Keep `Memory` and `Notes`, but separate them from the Dimension-style product pillars.
3. Rework the composer material:
   - Use a ProseMirror-compatible mental model even if the first implementation remains textarea-backed.
   - Add a connected-tools row below the input.
   - Make mode/model/mic/send controls visually closer to the Dimension computed styles.
4. Add a `TabSuggestionHint` to the active-thread composer when chat routes land.
5. Build chat thread primitives before more settings/list pages:
   - right-aligned user bubble
   - assistant prose with no bubble
   - run summary disclosure
   - thought pills
   - tool accordions
   - search result rows with favicons
   - structured action cards
6. Keep Alfred's explicit approval model, but reduce persistent instructional copy. Dimension relies on conversation as approval; Alfred can do better without making the home composer feel like a policy notice.

## Preservation notes

- Source maps are not available. This archive is now the authoritative source.
- The final `/chat` screenshot plus the preserved right-rail videos are the best references for the "expensive" feel.
- The accessibility trees are useful for exact copy, route structure, and interaction labels.
- The computed token extraction in this note and [`tokens.md`](./tokens.md) is sufficient to recreate the neutral/purple system closely.
- Do not clone Dimension's brand wholesale. Rebuild the interaction grammar and material language, then choose Alfred-specific copy, icons, and media.
