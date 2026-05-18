# Dimension design reference — 2026-05-18

Captured via Chrome DevTools live recon at `https://dimension.dev` on 2026-05-18, two days before the announced 2026-05-20 shutdown. All RGB values, sizes, and selectors below were pulled from `getComputedStyle` on live elements, not eyeballed. Evidence (screenshots, a11y trees, computed-style dumps) lives in [`_live/2026-05-18-deep/`](./_live/2026-05-18-deep/).

This is the canonical reference for any Alfred UI rewrite. It supersedes the earlier route-level notes for anything UI-grammar-related, and complements [`home-fidelity-gaps-2026-05-18.md`](./home-fidelity-gaps-2026-05-18.md) (which is route-specific) and [`alfred-frost-surface-map-2026-05-18.md`](./alfred-frost-surface-map-2026-05-18.md) (which is material-only).

Companion read for any rewrite: the actual changes we've shipped so far live in `apps/web/src/routes/index.tsx`, `apps/web/src/lib/app-shell.tsx`, `apps/web/src/lib/integration-icons.tsx`, `apps/web/src/lib/ui.tsx`, and `apps/web/src/index.css`.

## How to use this document

Three layers, biggest first:

1. **Tokens** — colors, radii, shadows, motion. The bedrock of everything else.
2. **Primitives** — Button, Input, Switch, Tabs, Dialog, etc. Every primitive references the tokens. Implement these first in any rewrite; routes then assemble them.
3. **Routes** — per-surface walk: `/chat`, `/chat/<id>`, `/integrations`, `/workflows`, `/skills`, `/library`, `/settings`, search modal. For each: default / hover / focus / active states + Alfred gap + recommendation.

If you only read one section, read **Primitives**. That's where the Dimension UI grammar lives.

---

## 1. Tokens

### Type

```css
body {
  font-family: "DM Sans", "DM Sans Fallback", ui-sans-serif, system-ui, sans-serif;
  font-size: 16px;
  line-height: 24px;
  font-weight: 400;
  letter-spacing: normal;
  color: rgb(237, 237, 237);
  background: rgb(12, 12, 12);
}
```

Scale (from observed live elements, not a documented type ramp — Dimension does not seem to have one beyond Tailwind defaults):

| Usage | Token | Computed |
|---|---|---|
| Body | `text-base` | `16/24 400` |
| Body small (prose, buttons) | `text-sm` | `14/20 400` |
| Body smaller (chips, meta) | `text-xs` | `12/16 400` (rare; Dimension prefers 13/14 over 12) |
| Composer pills, Connect Tools row | inline `text-[13px]` | `13/20 400` |
| Composer model picker, mode pills | inline `text-[15px]` | `15/22.5 400` |
| Page title (left-aligned `/settings`) | inline `text-[40px]` | `40/48 500` |
| Centered route title | `.heading-3xl text-[40px] font-medium` | `40/48 500` with gradient text |
| Greeting | `.heading-2xl text-4xl` | `36/40 400` with gradient text |
| Section header (Connected, Apps, …) | inline | `13/20 500` (small caps via context, not always uppercase) |
| Inline code | `text-xs font-mono` | `12/16 400` |
| Date / weak meta | `body-md text-lg` | `18/28 400` (rail and home) |
| Bold prose | `<strong>` | inherits size, `600` weight, white |
| Prose | `prose prose-sm dark:prose-invert` | `14/24 400`, color `rgb(209, 213, 219)` |

Key takeaways:
- Dimension's app rarely uses `text-base` (16) for body chrome — most everything is `text-sm` (14) or `text-[13px]`. 16 is the *fallback* body size, not the design intent.
- Big display sizes are 36px (greeting) and 40px (route titles). No 48/56/64 hero.
- **Display text uses a `bg-clip-text` gradient `linear-gradient(180deg, white, white/60)`** — never plain white. This is the single most repeated typographic flourish.
- Active tabs use a different gradient: `linear-gradient(180deg, white, #BFBCEF)` — lavender bottom — which gives the selected tab its "lit" feel.

### Color palette

Dimension stores colors as `--{name}-{stop}: R G B` (space-separated RGB triplets, Tailwind v3 convention). The full tables live in [`_live/2026-05-18-deep/palettes-full.json`](./_live/2026-05-18-deep/palettes-full.json) and [`_live/2026-05-18-deep/tokens.json`](./_live/2026-05-18-deep/tokens.json).

**Neutral (gray)** — 16 stops:

| Stop | RGB | Hex | Notes |
|---|---|---|---|
| 0 | `0 0 0` | `#000000` | true black, used in `bg-gray-0/70` overlays |
| 25 | `16 16 16` | `#101010` | rail bottom, popover surfaces |
| 50 | `28 28 28` | `#1c1c1c` | input fill (at 50% opacity) |
| 100 | `35 35 35` | `#232323` | input default border, switch off track |
| 200 | `40 40 40` | `#282828` | input hover border |
| 300 | `46 46 46` | `#2e2e2e` | input focus border |
| 400–500 | `52–62` | `#343434–#3e3e3e` | rarely used |
| 600 | `80 80 80` | `#505050` | divider variants |
| 700 | `112 112 112` | `#707070` | disabled text |
| 800 | `160 160 160` | `#a0a0a0` | **muted text** — buttons, captions, secondary copy |
| 850 | `190 190 190` | `#bebebe` | step between 800 and 900 |
| 900 | `209 209 209` | `#d1d1d1` | hover text uplift |
| 950 | `237 237 237` | `#ededed` | **default body text** |
| 1000 | `255 255 255` | `#ffffff` | accent text, gradient top |

Body background is `rgb(12, 12, 12)` (`#0c0c0c`) — slightly darker than `--gray-25`. Workspace panels, modals, popovers all sit on top of this base.

**Brand (purple)** — 11 stops:

| Stop | RGB | Hex |
|---|---|---|
| 50 | `34 27 75` | `#221b4b` |
| 100 | `55 45 130` | `#372d82` |
| 200 | `64 47 164` | `#402fa4` |
| 300 | `79 55 203` | `#4f37cb` (primary button bottom stop) |
| 400 | `83 59 229` | `#533be5` (switch-on track, purple accent) |
| 500 | `107 98 242` | `#6b62f2` (focus ring) |
| 600 | `128 129 249` | `#8081f9` |
| 700 | `164 172 253` | `#a4acfd` |
| 800 | `199 205 254` | `#c7cdfe` (active tab gradient bottom — slightly different shade `#BFBCEF` used inline) |
| 900 | `224 228 255` | `#e0e4ff` |
| 950 | `238 241 255` | `#eef1ff` |

The primary button uses `from-[#5d44df] to-[#4f37cb]` — sits between purple-300 and purple-400, slightly brighter than the named stops.

**Semantic palettes** (red, green, yellow, orange, blue, sky, teal, emerald, lime, magenta, pink) — all 11-stop, all Tailwind-default values. See `palettes-full.json`. Used sparingly:

- Inline code text: `--green-700` (`#6ee7b7`)
- Auto-pill green indicator: `--emerald-400` (`#22c55e`) — note: Dimension uses `bg-emerald-400`, Tailwind's emerald, not green.
- Destructive button: `--red-400` (`#dc2626`)
- Refer banner: `--yellow-500/10` fill + `--yellow-700` ring
- Shutdown notice: `bg-[#1c1814]` + `border-amber-500/15`

### Surfaces

Recurring background recipes:

| Token | Value | Used for |
|---|---|---|
| Body | `rgb(12, 12, 12)` | App background |
| Sidebar | `bg-[#0c0c0c]` (same as body, isolated by border) | Left rail |
| Row hover fill | `bg-[#131313]` (`rgb(19,19,19)`) | Sidebar items, recent threads |
| Row hover fill (cards) | `bg-[#181818]` (`rgb(24,24,24)`) | Integration row hover, focus-visible |
| Frost panel (tables, blocks) | `bg-[#1b1b1b]/50 backdrop-blur-sm` + `frost-border` | Code tables, structured outputs |
| Frost popover (search modal) | `bg-gray-100/85 backdrop-blur(8px)` | `cmdk` dialog body |
| Overlay backdrop | `bg-gray-0/70 backdrop-blur(4px)` | Modal dim |
| Black-on-rail control | `bg-black/20 backdrop-blur-sm` | Rail tab group, Add-to-do button |
| Translucent control | `bg-white/[0.05]` | Secondary button rest, mode pill rest |
| Translucent hover | `bg-white/[0.08]` | Secondary button hover |
| Translucent active | `bg-white/[0.03]` | Secondary button active (yes, dimmer than rest) |
| Black hover (light mode) | `bg-black/[0.03]` → `bg-black/[0.08]` | Same recipe, inverted |
| Composer body | `bg-gray-25/75` over body | Home composer |

Most surfaces follow one of three patterns:

1. **Translucent white over near-black body** (`bg-white/[0.05]` etc.) — for buttons, pills, inline chrome.
2. **Hardcoded dark fill** (`#131313`, `#181818`, `#1b1b1b`) — for row hovers, panels, tables.
3. **Frost** (translucent + blur + `frost-border` hairline) — for floating overlays, agent-generated content.

### Radii

| Token | Px | Used for |
|---|---|---|
| `rounded-md` | 6 | Inline code chips |
| `rounded-lg` | 8 | Inputs, model picker, kebab buttons |
| `rounded-xl` | 12 | Sidebar nav rows, integration icon tiles |
| `rounded-2xl` | 16 | Cards, frost panels (tables), composer outer, modal body |
| `rounded-[14px]` | 14 | Rail mode tab cells |
| `rounded-3xl` | 24 | Right rail, composer thread mode, search dialog, upgrade card, route headers |
| `rounded-full` (`9999px`) | — | Every button (yes — Dimension is uniformly pill-shaped), avatars, status dots |

**Heuristic**: small chrome = `rounded-lg` or `rounded-xl`. Cards = `rounded-2xl`. Hero surfaces / overlays = `rounded-3xl`. All clickable buttons are `rounded-full` unless they're a tab cell or icon button.

### Shadows

Three canonical shadow recipes appear over and over:

```css
/* 1. Send-button "lifted disk" — used for primary action affordances above bright surfaces */
box-shadow:
  inset 0 0 0 0.5px rgba(0,0,0,0.4),   /* hairline edge */
  0 18px 11px rgba(0,0,0,0.01),         /* extreme falloff bottom */
  0 8px 8px  rgba(0,0,0,0.01),          /* mid falloff */
  0 2px 4px  rgba(0,0,0,0.02);          /* near falloff */

/* 2. Primary-button inset frost — used on every frost-border button */
box-shadow: inset 0 0 7px 1px rgba(255,255,255, calc(0.13 * var(--frost-strength)));
/* hover: same with 0.22; active: back to 0.13 — preserves the lift on press */

/* 3. Model-picker inset dark — used on dark-glass control surfaces */
box-shadow: inset 0 0 4px rgba(0,0,0,0.4);
```

Plus a "modal shadow" used on the search dialog:

```css
box-shadow:
  0 10px 15px -3px rgba(0,0,0,0.1),
  0 4px 6px -4px rgba(0,0,0,0.1);
```

There is no general-purpose drop shadow (no `shadow-sm/md/lg`). Every surface that lifts off the background does it through *inset* highlights, not outset shadows — the body stays calm and only the foreground glows.

### `frost-border` (the most reused pattern)

A 1px gradient hairline border applied via a `::before` pseudo-element. It's the visual signature of every primary-action button (purple, white, red) and every floating panel. Dimension parameterizes it with two CSS vars:

```css
--frost-strength: 0–1     /* multiplier on the inset white glow opacity */
--frost-border-strength: 1–3  /* multiplier on the border-gradient opacity */
```

Default: both 1. Loud surfaces (Upgrade Plan white pill) bump both to 3 and 0.8. Subtle surfaces use 1 and 0.3.

The Alfred codebase already has `.frost-popover`, `.frost-panel`, `.frost-icon-tile`, `.frost-badge` in `apps/web/src/index.css`. To match Dimension's `frost-border` button hairline we still need to add either a CSS class or a `Button` primitive that paints the gradient hairline.

### Motion

Observed easings and durations:

| Where | Duration | Easing | Property |
|---|---|---|---|
| Sidebar collapse | 150ms | default (linear or ease) | `transform` |
| Rail video crossfade | 1000ms | `ease-in-out` | `opacity` |
| Button hover (most) | 200ms | default | `background-color`, `box-shadow`, `filter` |
| Active-press scale | snap (no transition, instant) | — | `transform: scale(0.96)` on `:active` |
| Search modal open | spring-ish via Tailwind animate | `data-[state=open]:animate-in fade-in-0 zoom-in-95` | combined |
| Tabs underline | 200ms | default | `background-color`, `color` |
| Switch knob | implicit via CSS transition | — | `transform` |

Active-press scaling is the most consistent motion: `active:scale-[0.96]` or `active:opacity-90`. No bounce, no rebound.

### Scrollbars

`--scrollbar-track` and `--scrollbar-thumb` exist as themed vars; Dimension uses `.hide-scrollbar` in most places (`scrollbar-width: none`).

### Native shell tokens

Even though Dimension is web-first, several vars are reserved for a native wrapper:

- `--desktop-title-bar-height: 2rem`
- `--desktop-outer-padding-height: calc(0.75rem + 2px + 2px)`
- `--safe-area-inset-{top,bottom,left,right}: 0px`
- `--keyboard-height: 0px`

These are wired into things like the search modal positioning (`desktop:top-[var(--desktop-title-bar-height)]`). For Alfred web-only we can ignore these, but they're worth keeping in mind if we ever package as Tauri/Electron.

---

## 2. Primitives

Each primitive is named, given default + hover + focus + active + disabled recipes, and described enough that a fresh implementation should hit Dimension's UI grammar.

### 2.1 Button

Dimension has **one** button shape — `rounded-full`. Every button is a pill. The only thing that changes is fill and inset shadow.

Five variants:

| Variant | Fill | Text | Border | Inset shadow | Hover | Active | Disabled |
|---|---|---|---|---|---|---|---|
| **Primary (purple)** | `linear-gradient(180deg, #5d44df, #4f37cb)` | white | `frost-border` (1px gradient via ::before) | `inset 0 0 7px 1px rgba(255,255,255,0.13)` | `inset` glow → `0.22` | `inset` glow → `0.13` | `brightness(0.8)`, `text-[#e0e0e0]` |
| **Primary (white)** | `linear-gradient(180deg, rgba(255,255,255,0.85), #eeeeee)` | black | `frost-border` (stronger: `--frost-strength: 0.8`, `--frost-border-strength: 3`) | `inset 0 0 7px 1px rgba(255,255,255,0.16)` + `0 0 0 1px rgba(0,0,0,0.08)` | inset → `0.28`, ambient → `0 2px 12px rgba(255,255,255,0.18)` | inset → `0.16` | `brightness(0.95) saturate(0.7)` |
| **Destructive (red)** | `linear-gradient(180deg, #dc2626, #dc2626)` (solid red gradient) | white | `frost-border` | `inset 0 0 7px 1px rgba(255,255,255,0.26)` | implicit brighter | implicit | `brightness(0.8)` |
| **Ghost (translucent white)** | `bg-white/[0.05]` (dark) / `bg-black/[0.03]` (light) | `text-gray-800` (`#a0a0a0`) | none | none | `bg-white/[0.08]`, `text-gray-900` (`#d1d1d1`) | `bg-white/[0.03]` (yes, dimmer than rest — the press goes through) | `bg-gray-100, text-gray-700` |
| **Send (gray→white disk)** | `linear-gradient(180deg, #a5a5a5 46%, #e3e3e3 100%)` | black/foreground | `frost-border` (subtle) | `0 0 0 0.5px rgba(0,0,0,0.4)` + ambient stack | `brightness(1.1)` | `brightness(1.05)` | `opacity-50` |

Sizes (heights):

- **sm**: `h-7` (28) — kebab, icon-only utility buttons inside cards. `rounded-lg` (8). Square.
- **md**: `h-8` (32) — Share button, mode pills. `rounded-full`.
- **md+**: `h-9` (36) — Manage/Connect ghost buttons, integration row buttons. `rounded-full`.
- **lg**: `h-10` (40) — Create Workflow / Create Skill / Upgrade Plan / Logout — every primary CTA. `rounded-full`.

Padding (horizontal):

- `px-3` (12px) for sm and small icon-only
- `px-4` (16px) for md+ and lg

Icon-only buttons use `size-N` (square) and `rounded-lg`. Text buttons use `rounded-full`. **There is no "outline" or "secondary border" variant.** The only borders are `frost-border` gradients on primaries — not solid lines.

Press: `active:scale-[0.96]` on icon buttons; `active:brightness-[0.95]` or `active:opacity-90` on filled buttons.

Focus: `default-ring` utility — Dimension's named focus utility. From class scans: `focus-visible:ring-purple-400 focus-visible:ring-offset-0` on primary buttons, `focus:ring-1 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-gray-25` on input-like controls.

**Alfred today**: we have one ad-hoc button in `apps/web/src/lib/ui.tsx` (`Button`) plus several inline buttons across routes. Not aligned. Build a single `Button` primitive that takes `variant` (`primary | white | destructive | ghost | send`) and `size`.

### 2.2 Icon button

Square, `rounded-lg` (8px), `size-7` (28) or `size-8` (32). Default `text-gray-800`, `hover:bg-gray-100 hover:text-gray-900`. Visibility-controlled inside sidebar rows: `opacity-0 group-hover/sidebar-item:opacity-100`.

**Alfred today**: `ToolButton` exists. Close but doesn't use `frost-border` for primary icon-buttons (mic, send). For consistency the icon button should be its own primitive; primary affordances embed a Button.

### 2.3 Input (text)

```
default:
  bg-[#1c1c1c]/[0.5]                 -> rgba(28,28,28,0.5)
  border-1 border-gray-100           -> #232323
  text-gray-950, placeholder:text-gray-800
  rounded-lg (8) or rounded-full (search variant)
  px-3 py-2 text-sm (h-9 / h-[38px])
hover:
  bg-[#1c1c1c]/[0.8]
  border-gray-200                    -> #282828
focus:
  bg-[#1c1c1c]/[1]
  border-gray-300                    -> #2e2e2e
  outline-none (no shadow ring)
disabled:
  opacity-50 cursor-not-allowed
```

The search variant on `/integrations` adds `pl-9` to fit a leading magnifier glyph and uses `rounded-full`.

**Alfred today**: no shared `Input` primitive. Build one and standardize.

### 2.4 Textarea

Two patterns:

- **Inline (editor)**: `bg-transparent border-0 p-0 resize-none focus-visible:ring-0`. Used inside the composer, where the *outer* container is the chrome.
- **Card (form)**: same recipe as the text input, but `min-h-[N]px max-h-[Mpx]` and `resize-none`. Used for "Background" and "Prompt".

`text-2xl font-medium` is used for the *title-style* editable text (skill editor "Untitled skill") — a textarea styled as a heading.

### 2.5 Switch (toggle)

```
track:
  h-6 w-11 rounded-full frost-border border-transparent backdrop-blur-sm
  off: bg-[#232323]
  on:  bg-purple-400 (dark) / bg-purple-300:hover

knob (via ::after pseudo):
  rounded-full, scales/translates on state change
```

44×24 px. The purple-on state matches the primary brand. **No "small" variant observed** — Dimension uses a single switch size.

### 2.6 Checkbox

Visible in the "Add new to do" rail row: a 16px square with `border-white/40`, no rounded (or `rounded-sm`). Empty state. Checked state not captured but conventionally fills with `bg-white` and a black check.

### 2.7 Tabs

Two flavors:

**Underline tabs** (skill editor — Learn / History):

- Buttons stacked horizontally with `pb-1.5 px-2 text-sm`
- Inactive: `text-gray-800 hover:text-gray-900`
- Active: text turns into a gradient `from-white to-[#BFBCEF] bg-clip-text text-transparent`, **and** an absolutely positioned underline (purple) sits at the bottom of the active tab
- Group container: just `inline-flex` with a hairline `border-b` underneath (the inactive tabs sit on a `border-b border-white/10` baseline; the active tab's underline overlaps)

**Segmented tabs in dark pill** (rail mode group):

- Outer: `inline-flex rounded-2xl bg-black/20 p-1 backdrop-blur-sm`
- Each tab: `h-9 w-14 rounded-[14px] grid place-items-center`
- Inactive: `text-white/50 hover:text-white/90`
- Active: `text-white bg-white/[0.12] inset-ring 0 0 0 0.5px white/14`

**Mode pills** (settings — Gmail / Slack / iMessage / Mobile Notifications):

- Outer: thin `inline-flex` row, no track
- Each pill: `px-3.5 py-1.5 rounded-full` (probably) with icon + label, gap 2
- Inactive: `text-gray-800 hover:text-gray-900`
- Active: white-ish fill on the pill itself + `text-gray-950`
- Disabled: `cursor-not-allowed opacity-50`

### 2.8 Card

Two flavors:

**Plain work card** (integration row, workflow card, skill card, library artifact):

```
default:
  p-3 w-full rounded-2xl
  text-sm text-gray-800
hover:
  bg-[#181818]
focus-visible:
  bg-[#181818]   (same as hover, no ring)
```

The row has an internal layout: icon tile (left, 40–48px square, `rounded-lg`, brand-tinted bg) + name + description + trailing action button (Manage / Connect / Coming Soon).

**Frost panel** (chat code/table blocks, frost overlays):

```
relative w-full rounded-2xl p-1 frost-border transition duration-200
bg-[#1b1b1b]/50 backdrop-blur-sm
shadow: inset 0 0 0 0.5px rgba(0,0,0,0.4)
::before opacity 25  (the frost-border gradient itself)
```

Inner cells/rows use generous padding (~12px) and `border-white/5` dividers.

### 2.9 Dialog / Modal (cmdk / search)

```
overlay:
  fixed inset-0 z-[100]
  bg-gray-0/70 backdrop-blur(4px)
  animate-in fade-in-0 / animate-out fade-out-0

dialog body:
  fixed bottom-0 left-0 on mobile (sheet)
  sm:bottom-auto sm:left-1/2 sm:-translate-x-1/2 sm:max-w-lg
  max-h-[70dvh]
  rounded-3xl (24px)
  bg-gray-100/85 backdrop-blur(8px)
  shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)
  animate-in fade-in-0 zoom-in-95 / animate-out fade-out-0 zoom-out-95
```

Search input inside: `flex w-full py-[18px] text-sm bg-transparent border-none focus:outline-none focus:ring-0`. Result rows: `text-sm font-medium line-clamp-1` with optional leading icon and trailing keyboard hint chip (e.g., ↵).

The dialog uses cmdk-style API (`[cmdk-root] [cmdk-item]` selectors), so the underlying primitive is `cmdk` + Radix Dialog.

### 2.10 Popover / Dropdown

Same material recipe as the dialog (`frost-popover`), smaller scale. Examples:

- Mention picker (in-composer)
- Model picker (Dimension / Dimension Pro)
- `+` two-row menu (Add photos & files / Mention)
- Recent-thread kebab menu

Common shell: `rounded-2xl p-2 max-w-[19rem]` with `frost-popover` material. Rows: `h-11 rounded-[10px] px-2 text-sm` with icon tile + label + optional trailing meta.

The mention picker is the canonical implementation in Alfred today (`apps/web/src/routes/index.tsx`).

### 2.11 Tooltip

Not directly observed in this pass, but `title` attributes are used heavily (e.g., the kebab buttons rely on native browser tooltips). A real tooltip primitive would be Radix Tooltip with the same `frost-popover` background.

### 2.12 Toast / Notifications

`[role="region"][aria-label="Notifications alt+T"]` exists on every page — sonner / Radix Toast region. Custom CSS vars are reserved (`--normal-bg`, `--success-bg`, `--info-bg`, `--warning-bg`, `--error-bg`) but not styled in the live page (no toast was visible). The naming pattern follows Sonner.

### 2.13 Avatar

The model picker has a small avatar circle (16px) on the left of the "Dimension" label, painted with a radial gradient (no real image). Pattern:

```
size-4 rounded-full
bg-[radial-gradient(circle_at_30%_30%,#a5a5a5,#1e1e1e_70%)]
inset-shadow: 0 0 0 0.5px rgba(255,255,255,0.12), 0 -1px 0 rgba(0,0,0,0.4)
```

Real user avatars in the sidebar use the same `size-7` rounded-full disc with the user's initial.

### 2.14 Status indicators

- Status dot (composer Auto pill green): `size-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55), inset_0_1px_0_rgba(255,255,255,0.4)]`
- Health dot (Alfred-specific, not in Dimension): `size-1.5 rounded-full bg-emerald-300 / red-300 / white-50`

### 2.15 Keyboard shortcut chip

Small inline pill displayed next to nav rows and primary actions:

```
inline-flex items-center px-1 rounded-md
border border-white/10 bg-white/[0.04]
text-[11px] tabular text-white/60
```

Examples: `⇧O` next to New Chat, `⌘K` next to Search, `⌘↵` next to "Learn" button.

### 2.16 Section header

Two patterns:

- **Route title (centered, gradient)**: `text-[40px] leading-[48px] font-medium bg-clip-text text-transparent bg-gradient-to-b from-gray-1000 to-gray-1000/60 tracking-tight` — used on `/chat`, `/integrations`, `/workflows`, `/skills`, `/library`.
- **Route title (left-aligned)**: same gradient, but inside a left-aligned page (only `/settings`).
- **Section header in a panel**: smaller — looks like inline `text-base font-medium` with optional leading icon (see "Account Information" with a user icon in `/settings`).

### 2.17 Page subtitle

Beneath the title: `text-sm text-gray-800` or `text-base text-gray-700`. Always one line. Always centered when the title is centered.

### 2.18 Divider

`border-b border-white/10` or `border-white/20` for panels. Inside a card, dividers go `divide-y divide-white/[0.05]`.

### 2.19 List row

Generic interactive list row pattern:

```
h-10 px-3 rounded-xl
hover:bg-[#131313]   (sidebar) or bg-[#181818] (card)
focus-visible:bg-[#181818]
```

Always uses the inner-pseudo trick to swap the background without changing the row's own `transparent` bg — so the hover doesn't fight with `<a>` underlines etc.

### 2.20 Banner (informational/promotional)

The shutdown notice is the cleanest example:

```
relative z-30 w-full border-b border-amber-500/15 bg-[#1c1814]
h-[36px], text-sm centered
links: 'Learn more' underlined, color matches body white
```

The `Refer and earn credits` banner is a "warm" variant:

```
rounded-xl px-3 py-2.5
bg-yellow-500/10 hover:bg-yellow-500/15
ring-inset ring-yellow-700
```

---

## 3. Routes

### 3.1 `/chat` (new)

Already documented extensively in [`home-fidelity-gaps-2026-05-18.md`](./home-fidelity-gaps-2026-05-18.md). Headline gaps from that doc are mostly closed in Alfred as of the 2026-05-18 home pass. Remaining gaps:

- Composer outer radius (we matched at 16; verify after rewrite proposal lands)
- Connect Tools row provider count (we have 10; matches)
- Setup nudge absolute-bottom positioning (we matched)

New observations from this deeper pass:

- The composer wrapper element on `/chat` and `/chat/<thread>` is the **same** `rounded-3xl` container — the difference is composer body radius (`16px`) versus outer rail radius (`24px`).
- The composer body has a `mask: linear-gradient(...)` on the editor that fades the top and bottom 12px of any long input — we don't have this. **Action**: add to Alfred composer textarea wrapper.

**Recommendation**: keep the home route as it is post-pass. Add the mask-gradient fade only.

### 3.2 `/chat/<thread>`

Layout: same shell, no rail (`<aside>` hidden when in a thread), main column becomes full-width. Composer pinned bottom, prose pane scrolls.

Default state observations:

- Header row: thread title (`text-xl font-medium`, left-aligned), kebab + `Share` button right-aligned.
- `Share` button is the canonical **ghost** button: `h-8 rounded-full px-3 bg-white/[0.05] hover:bg-white/[0.08]`.
- Prose container: `prose prose-sm dark:prose-invert max-w-full` — Tailwind Typography. Column visually capped at ~640px on wide screens.
- Bold prose `<strong>` is plain `font-weight: 600` and **white** (full white, not the body 237). All other prose is `rgb(209, 213, 219)` = white/85.
- Inline code: `rounded-md border-0.5 border-white/10 bg-[#171717] px-1 py-px font-mono text-xs text-green-700` — dark fill, mint-green code text.
- Tables: rendered as `frost-panel` (`rounded-2xl bg-[#1b1b1b]/50 frost-border backdrop-blur-sm`).
- Composer at the bottom is the same component, but it shows a **ghost follow-up** like `go ahead and save it` with a small `Tab` keycap on the right. (Stubbed in our doc; we don't yet know the styling — likely `text-white/40` ghost text + a `kbd` styled `Tab` chip.)
- "Thought for Ns" pill and "Finished N actions" accordion header appear in some threads. Not directly captured in this pass (the test thread didn't have them visible at the time of snapshot).

**Alfred state**: thread route doesn't exist yet (m13). The composer and prose styles can be lifted directly from this section when m13 lands.

**Recommendation when m13 ships**:

- Reuse the home composer component for the thread composer; only the wrapper layout changes.
- Add a `prose` className wrapper based on Tailwind Typography with the color overrides observed here.
- Build `frost-panel` table renderer for tables and code blocks (we have the CSS class already — just plug into the markdown renderer).
- Add `Tab` follow-up hint as a child of the composer that renders when the assistant has a suggestion buffered. Behaviour: pressing `Tab` accepts the suggestion.

### 3.3 `/integrations`

```
[ centered page title gradient ]
[ centered subtitle gray-800 ]
[ centered search input rounded-full w-[658] ]

[ section: Connected (3 cards/row, p-3 rounded-2xl) ]
[ section: Apps ]
[ section: Productivity ]
[ section: Business ]
[ section: Development ]
[ section: Your Integrations (MCP Server) ]
```

Card row anatomy:

- `40 × 40` brand icon tile, `rounded-lg`, real provider icons (Gmail M, Calendar grid, Drive triangle, Notion N, GitHub octocat, Linear L, Slack, etc.)
- Name (`text-sm font-medium`, color `text-gray-950`)
- Description (`text-[12.5px] text-gray-800`, single line)
- Trailing button: `Manage` (connected, ghost) or `Connect` (not connected, ghost — yes, same style; the verb differs but the chrome is identical) or `Coming Soon` (ghost disabled)

Row hover: `bg-[#181818]`. Button hover (within row): white/[0.08] (independent of row).

Search input: `bg-[#1c1c1c]/[0.5] rounded-full h-[46px] px-9 text-sm border-gray-100` with magnifier on the left at 16px.

Section headers: `text-base font-medium text-white` (no icon, no uppercase).

**Alfred state**: `apps/web/src/routes/integrations.tsx` uses the shared `Card`, `PageHeader`, `SectionHeader`, `Pill` primitives in `ui.tsx`. It's close, but:

- Our page title is not gradient; ours is plain heading.
- Our card layout is similar but our row hover fill is not `#181818`.
- We have explicit `connected | available | soon` pills; Dimension uses verb-on-the-button instead. Their pattern is cleaner.
- We don't have the search input.
- We don't have the multi-section grouping (Apps / Productivity / Business / Dev) — we only have "Connected" and "Available".

**Recommendation**: rewrite `/integrations` to use the new primitives. Group integrations by category. Use the verb-on-button pattern. Drop the inline status pill.

### 3.4 `/workflows`

```
[ centered page title 'Workflows' (gradient) ]
[ centered subtitle 'Create a scheduled or trigger-based workflow.' ]
[ right-aligned 'Create Workflow' purple primary button ]
[ grid of workflow cards (1 wide, looked like 1-col but probably responsive) ]
```

Cards:

- Icon tile + workflow name (h3) + description
- Click opens the workflow editor (not captured in this pass — would need to click into "Untitled workflow")

Empty card: the first card we saw was literally titled "Untitled workflow" with "Click to edit your workflow" — suggesting workflows can be drafted before publishing.

**Alfred state**: `apps/web/src/routes/workflows.tsx` is a placeholder list. We have it close in structure — three built-in workflow rows, a "New workflow" textarea card, an empty state for history.

**Recommendation when m12 ships full authoring**:

- Promote the `Create Workflow` button into a real primary action (purple). Currently a disabled secondary.
- Use the Dimension card layout: icon tile + name + description, hover fill `#181818`.
- Build a real workflow editor route — anatomy still TBD; this pass didn't capture it.

### 3.5 `/skills`

Same shell as `/workflows`. Cards on the list page show a brand-orange/amber icon tile + skill name (h3) + 3-line description.

Skill editor (`/skills/<id>`):

```
[ '← All skills' breadcrumb ]
[ editable 'Untitled skill' big title — actually a textarea styled as text-2xl font-medium ]
                                                [ kebab ] [ Share ghost button ]
[ tabs: Learn (active, gradient text + purple underline) | History ]

[ section header 'Using Integrations' (text-base font-medium) ]
[ helper 'You can mention integrations using @ in the prompt' ]
[ section header 'Prompt' ]
[ large rounded textarea ]

                                                [ 'Learn' purple primary button + ⌘↵ keycap ]
```

The "title as textarea" pattern is great — feels like Notion. No save button: edits autosave.

**Alfred state**: `apps/web/src/routes/skills.tsx` doesn't have a per-skill editor route.

**Recommendation when m12 ships user-authored skills**: build `apps/web/src/routes/skills.$skillId.tsx` with the Dimension layout. Reuse the breadcrumb, title-as-textarea, and tabs primitives we'll build.

### 3.6 `/library`

```
[ centered title 'Library' gradient ]
[ centered subtitle 'Browse all your created artifacts.' ]

[ filter pill row: 'All Types' (filter icon) | 'Favourites' (star icon) ]   [ search input right-aligned ]

[ grid of artifact cards: thumbnail + title + meta-line + kebab ]
```

Artifact card anatomy:

- Top: thumbnail preview (a rendered PDF/doc cover-like image, 4:3 or 16:9 — felt taller than wide)
- Title (`text-sm font-medium`, `line-clamp-2`)
- Meta line (`text-xs text-gray-800`): icon + format + ` · ` + date (`May 16`)
- Kebab on the right of the meta line

Filter pills:

- `rounded-full` with icon + label
- Selected has a clear fill, unselected is `bg-white/[0.05]`

**Alfred state**: `apps/web/src/routes/library.tsx` is a placeholder — no artifact rendering.

**Recommendation when artifacts land (m13+)**: copy the card layout exactly. Filter pills can use the same "mode pill" primitive from settings. Search input is the same `/integrations` search variant.

### 3.7 `/settings`

Layout differs from every other route: **left-aligned page title**, two-column body (inner-nav left, panel right).

Inner-nav rows (`User`, `Billing`, `Plan`, `Features`, `Preferences`, `Referrals`):

- 28px tall, `text-sm font-medium`, `gap-2` icon+label
- Inactive: `text-gray-800` (`#a0a0a0`) hover `text-gray-900` (`#d1d1d1`)
- Active: `text-gray-950` (`#ededed`) + purple LEFT BAR indicator (likely absolutely-positioned 2px wide)

Panel (right side):

- Wrapped in a card `rounded-2xl border border-white/5`-ish
- Section header with leading icon (`Account Information` user icon)
- Section description below header
- Form fields stack with `space-y-N`

Form field anatomy:

```
[ Label                                            ]
[ Helper text (gray-800)                           ]
[ Input full-width                                 ]
```

Special controls:

- **Mode pill row** (Preferred Mode of Communication): 4 pills horizontal, gap-2, icon + label inside each. Selected one has white fill on the pill.
- **Switch** (Auto Approve): right-aligned, label + description on the left, switch on the right.
- **Bordered card with prefilled text** (Background): a `textarea` styled as a card, dark fill, no visible border (or very subtle).
- **Logout** at the bottom: full destructive button — red gradient, white text, pill shape, h-10.

**Alfred state**: no `/settings` route yet. The "Personal" section in our sidebar has Memory and Notes; user has no place to manage profile / model preferences / connected integrations from a single page.

**Recommendation**: build `/settings` with the inner-nav pattern.

- Sections: User (profile + display name + email), Integrations (link to `/integrations`), Model (default model, when m13 lands the picker), Notifications (briefing settings, when m10 wires email_sends), Preferences (theme, density), Danger (sign out, delete account).
- Use the mode-pill row for any mutex choice (theme: System / Light / Dark).
- Use the Switch primitive for any boolean.

### 3.8 Search modal (`⌘K`)

Already detailed under primitives. Result row content on default empty query:

```
+ New Chat                                              ↵
* Settings
S Integrations
W Workflows
S Skills
L Library
```

With a typed query, recent chats and matching integrations appear as result rows (not captured in this pass — the test query wasn't entered).

**Alfred state**: `/Search` is a stub button in the sidebar; clicking does nothing.

**Recommendation**: build a `<CommandPalette>` primitive using cmdk + Radix Dialog. Routes register their command sets. Result rows use the same `h-11 rounded-md px-3 text-sm font-medium` recipe.

---

## 4. Cross-cutting observations

### A. The body is intentionally calm.

Dimension's body bg is `rgb(12, 12, 12)`. All surfaces sit on top of this near-black, with the *foreground* providing all the contrast and color. Nothing competes for visual primacy. This is the single biggest reason the product feels "expensive".

### B. The visual signature is purple, gradient, and pill.

Every primary action is purple. Every title is a vertical-gradient text fade. Every button is a pill. This trio is the entire brand language. If we adopt one thing from Dimension, this is it.

### C. Frost-border is a calculated weapon.

The 1px gradient hairline (`frost-border`) is reserved for surfaces that *matter*: primary buttons, floating overlays, frost panels (chat tables/code), the switch track. Plain panels and route cards do not get it. This selectivity makes the frost feel earned.

### D. Hover states fall into two patterns.

1. **Pseudo-fill swap** (sidebar rows, integration rows): the row itself stays transparent; an inner absolutely-positioned `<div>` swaps its background on `group-hover`. Cleaner than restyling the row.
2. **Direct fill** (buttons): the button's own bg interpolates between rest / hover / active stops.

### E. Press states are gentle.

`scale-[0.96]` on icon buttons, `brightness(0.95)` or `opacity-90` on filled buttons. There is no bounce or rebound. The press is acknowledged, not celebrated.

### F. Focus is mostly invisible, but the ring exists.

Most controls hide the focus ring under `focus:outline-none` and rely on `default-ring` (which only paints `focus-visible`, not mouse-focus). The ring is `ring-1 ring-purple-500 ring-offset-2 ring-offset-gray-25` when it appears.

### G. Skeleton / loading.

A `data-[loading=true]:cursor-wait data-[loading=true]:brightness-90 data-[loading=true]:text-transparent` pattern on buttons. Text fades out (`*:invisible`), background dims. Spinners visible during loading state — class `dont-hide-on-loading` keeps them rendered while siblings hide. We didn't capture the spinner shape in this pass.

### H. Empty states are emotional.

Every "nothing here" surface uses a **party-popper / sparkles burst icon** (`PartyPopper` from Lucide is the closest match) at `size-10` with `mix-blend-plus-lighter`. Copy reads positively: `All done!`, `No Suggestions`. Never `No data` or `Empty`.

### I. Mobile is a sheet.

The search modal dialog uses `bottom-0 left-0 max-w-[100vw] sm:bottom-auto sm:left-1/2 sm:-translate-x-1/2 sm:max-w-lg` — a true bottom-sheet on mobile, centered modal on desktop. Same pattern likely repeats for any future dialog.

---

## 5. Alfred-side rewrite proposal

Goal: get Alfred's UI to the visual quality of Dimension's, without becoming a Dimension clone. Three orders of magnitude:

### Stage 0 — Tokens (1 file, no behavior change)

`apps/web/src/index.css`:

- Add the full gray scale `--gray-{0..1000}` matching Dimension's stops.
- Add the full purple scale.
- Keep the semantic palettes minimal — only what we actually use (emerald, red, yellow). Dropping unused palettes is fine; Alfred isn't a public design system.
- Add `--frost-strength` and `--frost-border-strength` as inheritable CSS vars (default `1` and `1`).
- Add a `.frost-border` class that paints a 1px gradient hairline via `::before`.
- Ensure body `rgb(12, 12, 12)` and `font-family: "DM Sans"` (we have Open Runde today; switch or keep — see "Decision points" below).

Risk: extremely low. Pure additive CSS.

### Stage 1 — Primitives (new `apps/web/src/components/ui/`)

Build (or replace) one primitive at a time. Each comes with a small showcase route at `/styleguide` so we can review them in isolation.

Priority order, easiest first:

1. **`Button`** — variants: `primary`, `white`, `destructive`, `ghost`, `send`, `icon`. Sizes: `sm`, `md`, `lg`. All pill except `icon` which is square. The single biggest unification.
2. **`Input`** — text + search variant. `<Input variant="search" icon={<Search />} />`.
3. **`Textarea`** — auto-resize, no inner padding when used as inline editor.
4. **`Switch`** — Radix Switch wrapper, purple-on / dark-off.
5. **`Tabs`** — Radix Tabs; variants `underline` (skill editor) and `segmented` (rail mode tabs) and `pill` (mode pills).
6. **`Card`** — basic + hover variant (`hover:bg-[#181818]`).
7. **`FrostPanel`** — `rounded-2xl bg-[#1b1b1b]/50 backdrop-blur-sm frost-border`. Use for tables and structured agent output.
8. **`FrostPopover`** — Radix Popover wrapper; reuse for mention, model picker, kebab menus.
9. **`Dialog`** + **`CommandPalette`** — Radix Dialog + cmdk. Build the search modal here.
10. **`Avatar`** — radial-gradient pseudo-avatar + initial avatar.
11. **`Kbd`** — keyboard shortcut chip.
12. **`Toast`** — Sonner-based with the CSS vars Dimension defined.
13. **`PageHeader`** — centered or left-aligned title + subtitle.
14. **`StatusDot`** — emerald / amber / red / muted, with glow.

Refactor each existing route to use these primitives as they land. Don't try to convert everything at once; do `/integrations` first (high-traffic and the largest current visual gap), then `/workflows` and `/skills`, then `/library`, then `/settings`, finally `/chat` (which is the most polished today and should change last).

### Stage 2 — Routes (rewrite-on-demand)

- `/integrations`: full rewrite to the Dimension layout (search + category groups + verb-on-button + row hover).
- `/workflows` + `/skills`: rewrite list pages and stand up the editor routes (`/workflows/<id>` and `/skills/<id>`).
- `/library`: rewrite the artifact grid; defer the artifact viewer until artifacts actually exist.
- `/settings`: new route. Inner-nav + panel layout. Sections: User, Integrations (link), Model (placeholder), Notifications, Preferences, Danger.
- `/chat`: minimal touch — already close after the 2026-05-18 pass. Add the editor mask-gradient fade only.
- `/chat/<thread>`: ship with m13. Use the new primitives end-to-end.
- Sidebar (`app-shell.tsx`): adjust the nav row pseudo-fill pattern. Add a left-aligned "Settings" pinned at bottom (replacing the `Agent surfaces` info card). Add an inner row-hover that uses the `group-hover/sidebar-item:bg-[#131313]` pattern.
- Search modal: brand-new feature. Wire `⌘K` → CommandPalette.

### Stage 3 — Decision points (need user input before locking)

The recon left a few choices on the table; defaults are listed first.

1. **Font**: stay on Alfred's current `Open Runde / Inter` stack vs adopt `DM Sans`. Open Runde is distinctive; DM Sans is what Dimension uses. Default: stay on Open Runde — it's part of Alfred's identity.
2. **Brand color**: Dimension uses purple. Alfred has no brand color today. Adopt purple? Or pick another (we already have emerald in the Auto pill and elsewhere)? Default: emerald — it's already used for "Auto" affordance and reads as "ready / live" which fits an assistant.
3. **Greeting copy**: keep Dimension's `Good Morning,` capitalization, or use sentence case (`Good morning,`)? Default: sentence case — we shipped sentence case before, then switched to title case to match Dimension; if Alfred isn't cloning Dimension we should revert.
4. **Rail media**: still static gradient. Worth investing in an owned animated video/loop later? Default: defer — keep gradient until we have something better.
5. **MCP servers in `/integrations`**: Dimension shows "Your Integrations: MCP Server" as a free-form add-integration row. We have m14 (MCP client) scheduled. Default: build the empty section now, wire later.
6. **Referral banner**: not applicable to single-user Alfred. Default: skip.

### Effort budget

- Stage 0 (tokens): half-day.
- Stage 1 (primitives): 1.5 weeks if done right with showcase route. Each primitive is small but testing across themes/states adds up.
- Stage 2 (routes): 2–3 weeks, mostly `/integrations` rewrite + `/settings` greenfield + minor passes on others.
- Total: ~1 month of focused UI work, parallelizable with backend milestones.

### What NOT to do

- Don't ship a "v2" branch that runs in parallel. Refactor in place, primitive by primitive.
- Don't try to clone the rail video — without owning the asset, anything we produce will look cheap. Animated gradient + occasional weather-aware tint is fine for now.
- Don't import a UI library wholesale (shadcn, chakra, etc.). Dimension is hand-built and the precision is the reason it feels good. Build the primitives.
- Don't introduce a brand color we don't have a strong reason for. Emerald is already pulling weight; multiplying brand colors dilutes the system.
- Don't try to match Dimension's typography choices unless we also match their type rhythm — the small body sizes (13–14) are part of why the app reads as dense and serious.

---

## 6. Evidence index

All artifacts are in [`_live/2026-05-18-deep/`](./_live/2026-05-18-deep/) and are committed to the repo so the recon survives the 2026-05-20 shutdown:

| File | Surface |
|---|---|
| `tokens.json` | All CSS custom properties pulled from `:root` |
| `palettes-full.json` | Full red/green/yellow/orange/blue/sky/teal/emerald/lime/magenta/pink scales |
| `chat-default-fullpage.png` | `/chat` full-page screenshot |
| `chat-default-a11y.txt` | `/chat` accessibility tree |
| `chat-sidebar-hover-integrations.png` | Sidebar hover state (Integrations row) |
| `thread-fullpage.png` | `/chat/<id>` full-page screenshot |
| `thread-a11y.txt` | Thread accessibility tree |
| `integrations-fullpage.png` | `/integrations` full-page screenshot |
| `integrations-a11y.txt` | `/integrations` accessibility tree |
| `integrations-row-hover.png` | Hovered Manage button + row |
| `workflows-fullpage.png` | `/workflows` full-page screenshot |
| `workflows-a11y.txt` | Workflows tree |
| `skills-fullpage.png` | `/skills` list |
| `skills-a11y.txt` | Skills tree |
| `skill-create-form.png` | Skill editor (`/skills/<id>`) |
| `library-fullpage.png` | `/library` list with one artifact |
| `library-a11y.txt` | Library tree |
| `settings-fullpage.png` | `/settings` User section |
| `settings-a11y.txt` | Settings tree |
| `search-modal-default.png` | `⌘K` modal default empty state |

Earlier pass evidence (May 18 morning) is in `_live/2026-05-18-fresh/`:

- Dimension `/chat` viewport + a11y
- Dimension `/chat/<id>` viewport + a11y
- Rail background videos (`partly_cloudy.mp4`, `sunny.mp4`) preserved
- Alfred localhost dark + light + mention-menu captures
