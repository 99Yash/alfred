# Alfred UI rewrite — progress log

Tracking the staged rewrite proposed in [`dimension-design-reference-2026-05-18.md`](./dimension-design-reference-2026-05-18.md) §5. Updated continuously as work lands so the next agent can resume cleanly if the context window compacts.

## Locked decisions

| Decision | Value | Source |
|---|---|---|
| Brand color | **Purple** — Dimension's `from-[#5d44df] to-[#4f37cb]` gradient | User pick 2026-05-18 |
| Font | Open Runde (keep current) | Recon doc default (decision point #1) |
| Greeting copy | TBD (defer until route rewrite) | Recon doc decision point #3 |
| Rail media | Real video hook with CSS fallback; add owned `apps/web/public/videos/partly_cloudy.mp4` | 2026-05-19 browser bundle capture |
| Progress file location | `references/dimension-dev/REWRITE_PROGRESS.md` | User pick 2026-05-18 |
| Full UI roadmap | [`ui-reproduction-roadmap-2026-05-19.md`](./ui-reproduction-roadmap-2026-05-19.md) | 2026-05-19 route inventory |
| UI execution queue | [`ui-execution-queue-2026-05-19.md`](./ui-execution-queue-2026-05-19.md) | 2026-05-19 implementation ordering |

## Stages

### Stage 0 — Tokens (in `apps/web/src/index.css`) ✅ DONE 2026-05-18

- [x] Add Dimension's exact `--gray-{0..1000}` scale (16 stops) as space-separated RGB triplets — `:root`
- [x] Add Dimension's exact `--purple-{50..950}` scale (11 stops) — `:root`
- [x] Expose both scales as Tailwind utilities via `@theme inline` (`bg-gray-50`, `text-purple-400`, etc.) — overrides Tailwind defaults; safe since the codebase didn't use those utilities
- [x] Add `--frost-strength` (default `1`) and `--frost-border-strength` (default `1`) inheritable vars
- [x] Add `.frost-border` component class — pure-white hairline via `::before` with `inset: -0.5px`, `padding: 0.5px`, animated opacity for hover/active. **Recipe verified against a live Dimension Upgrade Plan button on 2026-05-18.**
- [x] Add `.heading-display` gradient-text utility (white → white/60) + `.heading-display-lavender` variant
- [x] Switch dark `--background` to `rgb(12, 12, 12)` (`#0c0c0c`)
- [x] Add motion vars: `--motion-hover: 200ms`, `--motion-easing: cubic-bezier(0.2, 0, 0, 1)`, `--press-scale: 0.96`

Recon-doc correction landed in §1: the frost-border ::before is a **pure-white** gradient (`white → white/25 → white/25 → white`), not the white-to-near-black mix that the earlier doc described. Animated via `::before { opacity: calc(0.25 * var(--frost-border-strength)) }`, lifted to `0.35` on hover. Padding is 0.5px not 1px. See `apps/web/src/index.css` for the canonical recipe — that file is now the source of truth.

### Stage 1 — Primitives (`apps/web/src/components/ui/`) ✅ DONE 2026-05-18 (initial set + second batch 2026-05-18)

Each primitive ships with a section in `/styleguide`.

- [x] `/styleguide` route scaffolded (apps/web/src/routes/styleguide.tsx) — token swatches + every primitive in default/disabled/loading state
- [x] **Button** — variants `primary | white | destructive | ghost | send`, sizes `sm | md | mdPlus | lg`. All pill-shaped. `apps/web/src/components/ui/button.tsx`
- [x] **IconButton** — square `rounded-lg`, sizes `sm` (28px) / `md` (32px). `apps/web/src/components/ui/icon-button.tsx`
- [x] **Input** — `default` (rounded-lg) + `search` (rounded-full) variants, leading/trailing slots. `input.tsx`
- [x] **Textarea** — `card` (Input recipe + min-h, resize-none) + `inline` (transparent, used inside composer chrome). `textarea.tsx`
- [x] **Switch** — hand-rolled (no Radix dep yet). Controlled or uncontrolled. 44×24 track, purple-400 on / gray-100 off, 20px white thumb. `switch.tsx`
- [x] **Tabs** — `underline | segmented | pill`. Item-based API. Active underline tab uses `heading-display-lavender` + purple underline. `tabs.tsx`
- [x] **Card** — `rounded-2xl`, hover/focus fill `#181818` via `interactive` flag. `card.tsx`
- [x] **FrostPanel** — thin wrapper around the `.frost-panel` CSS class. `frost-panel.tsx`
- [x] **Avatar** — radial-gradient disc, optional initial, sizes sm (16) / md (28) / lg (36). `avatar.tsx`
- [x] **Kbd** — 11px tabular chip with `border-white/10 bg-white/[0.04]`. `kbd.tsx`
- [x] **StatusDot** — emerald / amber / red / muted tones, sm / md sizes, with glow + inset highlight. `status-dot.tsx`
- [x] **Dialog** — Radix Dialog wrapper. `dialog.tsx`. `frost-popover` material, rounded-3xl, scrim with backdrop-blur, content fade+zoom on open/close via custom `@keyframes dialog-*` in index.css. Title + Description rendered (sr-only when `srOnlyHeader=true`) to satisfy Radix a11y warnings.
- [x] **CommandPalette** — cmdk + the Dialog primitive. `command-palette.tsx`. `CommandPalette.Group` + `CommandPalette.Item` (with leading icon tile + `↵` chip on the selected row) + `CommandPalette.Legend` (footer kbd hints).
- [ ] **FrostPopover** — `.frost-popover` CSS exists; React wrapper deferred until a popover consumer needs it

### Stage 2 — Routes (in progress)

Order: `/integrations` → `/workflows` + `/skills` → `/library` → `/settings` (new) → `/chat` minimal touch.

- [x] **`/integrations`** ✅ DONE 2026-05-18 — Rewritten to Dimension grammar in `apps/web/src/routes/integrations.tsx`.
  - Centered `heading-display` gradient title + subtitle + `Input variant="search"` (full-width, max 640px, h-46).
  - Five sections: **Connected** (Gmail, Google Calendar, Google Drive), **Apps** (Slack — soon), **Productivity** (Google Docs/Sheets/Slides — available, Linear — soon), **Development** (GitHub — available), **Your Integrations** (MCP Server — coming soon, placeholder for m14).
  - Verb-on-button pattern: `Manage` (connected, ghost) / `Connect` (available, ghost) / `Coming Soon` (soon, ghost disabled). Inline status pill **dropped** per recon doc recommendation.
  - Live search filter across name + description. Sections collapse when empty; full-page empty state shows `No integrations match "<q>".`
  - Cards use new `Card interactive` primitive — hover fills to `#181818` (verified visually).
  - All chrome routed through new `@/components/ui/*` primitives. No legacy `lib/ui.tsx` imports.
- [x] **`/workflows`** ✅ DONE 2026-05-18 — `apps/web/src/routes/workflows.tsx`.
  - Centered `heading-display` gradient title + subtitle + centered purple `Create Workflow` button (disabled — m12 placeholder, title attribute explains).
  - **Built-ins** section: stacked single-column list of three cards (Morning briefing / Email triage / Cold-start research), each with a brand-tinted icon tile (violet / emerald / amber), name, description, and right-aligned cadence chip (`Every day at 08:00` etc.). Cursor stays `default` because the rows aren't clickable yet — overrides Card's `interactive` cursor.
  - **Your workflows** section: empty-state Card pointing at m12 user-authored workflows.
  - All chrome through `@/components/ui/*`. No legacy `lib/ui.tsx` imports.
- [x] **`/skills` + `/skills/$slug`** ✅ DONE 2026-05-18 — `apps/web/src/routes/skills.tsx` and `apps/web/src/routes/skills.$slug.tsx`.
  - **List page**: centered gradient title + subtitle + purple `Create Skill` button. Single-column Card rows with sparkles icon tile, name, mono slug, and `SkillStatusPill` (legacy Pill via `lib/skills-ui.tsx` — works against dark surface, defer migrating to a `tone` prop on a new primitive until needed elsewhere).
  - **Instant-nav Create Skill** (the user-requested UX): server allows missing `name` / `prompt` → defaults to `Untitled skill`, no learn run fired. Client calls `client.api.skills.post({})`, awaits `rep.pull()` to force a Replicache sync before navigating, then routes to `/skills/$slug`. Aborted drafts persist by design.
  - **Detail page rewrite**: full primitive swap.
    - `← All skills` breadcrumb (light gray link).
    - Heading row: gradient `heading-display` title (28/34 medium) + mono slug + right-aligned `SkillStatusPill`.
    - `Tabs variant="underline"` (Learn / History) — active tab gets the `heading-display-lavender` gradient + 1px purple underline via the Stage 1b primitive. History tab embeds a tabular count chip.
    - **Learn tab**: Prompt section (heading + helper) → `Textarea variant="card"` (mono, 140px min-height, ⌘↵ submits via `onKeyDown`) → counter + purple primary `Button` with `Loader2 / RotateCw` leading icon and `<Kbd>⌘↵</Kbd>` trailing chip. Body section renders the current revision's markdown (no card chrome — matches Dimension's bare-prose look) or an empty-state Card.
    - Live `activeRun` banner uses an amber inset-ring style (no border-class — keeps the bg/ring tones aligned with the Dimension palette).
    - **History tab**: Card rows showing `kind` + `RunStatusPill` + tabular timestamps + revision ID.
  - **Routing fix**: `/skills/$slug` is a TanStack child of `/skills`, so the parent must render an `<Outlet />` for the slug to mount. The old code never did — the detail page was broken silently. Parent now uses `useChildMatches()` to render `<Outlet />` when a child matches, otherwise the list page. This also unblocks any future `/skills/$slug/...` nesting.
  - **API surface change (minor)**: `POST /api/skills` body is now `{ name?: string, prompt?: string }`. Empty `prompt` → no learn run fires; `name` falls back to `Untitled skill`. After creating a draft we now `emitReplicachePokes([userId])` so the client pulls before its detail page renders. See `packages/api/src/modules/skills/routes.ts`.
  - **Eden treaty credentials fix**: `client = treaty<App>(API_URL, { fetch: { credentials: 'include' } })` — without this, all cross-origin protected POSTs from `apps/web` (port 3000) → `apps/server` (port 3001) 401 because the Better Auth session cookie is stripped. Pre-existed as a latent bug; surfaced when we first wired Create Skill through the UI rather than the smoke script.
- [x] **`/library`** ✅ DONE 2026-05-18 — `apps/web/src/routes/library.tsx`.
  - Centered `heading-display` gradient title + subtitle (`Browse all your created artifacts.`).
  - Toolbar: `Tabs variant="pill"` (`All Types` w/ filter icon, `Favourites` w/ star icon) left, `Input variant="search"` right at 320px / h-40. Stacks on `<sm`.
  - Empty state — `PartyPopper` glyph + dynamic copy (search-active vs filter-active vs default). No artifact card grid yet because no artifact producer exists; layout is ready for the m13+ artifact gallery.
  - Migrated off legacy `lib/ui.tsx` (`PageContainer` / `PageHeader` / `Card` / `EmptyState`) entirely.
- [x] **`/settings`** ✅ DONE 2026-05-18 — `apps/web/src/routes/settings.tsx` (new route, picked up automatically by TanStack file-based routing).
  - **Layout** — diverges from the other routes per recon §3.7: left-aligned `heading-display` title in a `max-w-5xl` container; body is `grid md:grid-cols-[180px_1fr]` (inner-nav left, panel right). On `<md` the inner-nav flattens to a horizontal scrollable row.
  - **Inner-nav** — five sections (User / Integrations / Notifications / Preferences / Danger). Active row gets `text-gray-1000` + a 2px purple absolute left-bar (`absolute left-[-10px] top-1.5 bottom-1.5 w-[2px] bg-[rgb(var(--purple-400))]`). Hidden on mobile where the orientation flips.
  - **Panel** — `PanelCard` wrapper (`rounded-2xl border border-white/5 bg-[rgb(var(--gray-25)/0.4)] p-6 sm:p-8 space-y-7`). `PanelHeader` uses leading 14px icon + base/medium title + 12.5px helper. `Field` / `FieldRow` helpers for label/helper/control rows.
  - **Sections**:
    - **User** — display name (disabled, pre-filled), email (disabled), Background textarea (disabled, placeholder copy). Wired to backend lands with m13.
    - **Integrations** — link panel that navigates to `/integrations` via a `Button variant="ghost"`.
    - **Notifications** — Morning briefing (default on) + Auto approve (default off) `FieldRow`s using the `Switch` primitive. Local state only — m13 wires both to backend.
    - **Preferences** — Theme `Tabs variant="pill"` (`System` / `Light` / `Dark`) wired to `useTheme()` (real, persists to localStorage). Model picker placeholder reads `Alfred (default)` with sparkles glyph; picker lands with m13.
    - **Danger** — Destructive Logout button (real — calls `authClient.signOut()`, routes to `/login`, shows `loading` state via Button primitive). Destructive Delete account button (disabled, m13 placeholder).
- [x] **`/chat` composer mask-gradient fade** ✅ DONE 2026-05-18 — `apps/web/src/index.css` adds a `.composer-editor` rule applying `mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%)`. The home composer textarea already had the `composer-editor` class so the rule attaches without any TSX change. Verified in browser by dumping 14 lines into the textarea + scrolling — top and bottom 12px of the visible region fade to transparent. Per recon §3.1.
- [x] **Sidebar — Settings pinned at the bottom** ✅ DONE 2026-05-18 — `apps/web/src/lib/app-shell.tsx`.
  - Removed the "Agent surfaces" filler card (`Layers` icon + tagline) — never represented a real surface and the recon called it out as the slot for Settings.
  - Added `Settings` (`lucide:Settings` icon) as a single `<NavLink>` at the top of the footer block (above the theme + sign-out buttons). Active when `pathname === /settings`. Same chrome as section-nav rows so collapsed-mode shows just the icon with a tooltip.
- [x] **`/notes` + `/memory`** ✅ DONE 2026-05-18 — Stage 2d follow-up — `apps/web/src/routes/notes.tsx` and `apps/web/src/routes/memory.tsx`.
  - Both routes migrated off legacy `lib/ui.tsx` (`PageContainer` / `PageHeader` / `SectionHeader` / `EmptyState` / `Button` / `Pill` / `ToolButton`) to the new `@/components/ui/*` primitives. The legacy `Pill` import remains only via `lib/skills-ui.tsx` (skills detail page) — that carve-out is unchanged per open Q #4.
  - **`/notes`** — Same shell as `/workflows` + `/library`: centered `heading-display` title + subtitle. Composer rendered in a `max-w-[688px]` column that doubles as the column for the `Recent` section below it, so the heading + counter line up with the composer's left edge. Composer chrome reuses the home-page recipe (`rounded-2xl bg-[#080808]/95 ring-1 ring-white/10 backdrop-blur-sm`) wrapping a `Textarea variant="inline"` + the gray→white send disk. Mic button is the `IconButton` primitive (`rounded-full` override). Empty state renders inside a `Card` with `frost-icon-tile` glyph. Note rows are non-interactive `Card`s with the `whitespace-pre-wrap` body + `tabular` timestamp.
  - **`/memory`** — Same shell, body constrained to `max-w-3xl` because confirmed-fact rows read better in a narrower column (key + value + edit/forget cluster). Proposed cards use `Card` + the `Button` primitive (`primary` for Confirm, `ghost` for Edit/Reject, all `size="sm"`) plus an inline `ConfidenceChip` built from `StatusDot` (emerald ≥ 75% / amber ≥ 50% / red below) + a tabular percentage. Confirmed list is one `Card` wrapping a `divide-y divide-white/[0.04]` `<ul>` of rows. Toast stack now uses `frost-popover` material instead of the legacy `bg-popover` semantic token.
  - Verified end-to-end in Chrome on :3000: typed a smoke note → submit → row appears + textarea clears + composer keeps purple `focus-within` ring during typing. Confirmed-fact rows (44 facts in local DB) render cleanly within the narrower column. Type-check clean across all 10 packages.
  - Baselines: `notes-{before,v1,v2,v2-after-submit,v2-with-text}.png`, `memory-{before,v1,v1-viewport,v2,v2-viewport}.png` under `references/dimension-dev/_live/baseline-2026-05-18-rewrite/`.
- [x] **Search modal (`⌘K`)** ✅ DONE 2026-05-18 — Stage 3 — `apps/web/src/components/ui/dialog.tsx` + `command-palette.tsx`, wired in `apps/web/src/lib/app-shell.tsx`.
  - **Deps**: `@radix-ui/react-dialog@^1.1.15` + `cmdk@^1.1.1` added to `apps/web` (open question #7 closed — Radix path picked; Switch/Tabs stay hand-rolled).
  - **Primitive recipe** (recon §2.9 + §3.8): `rounded-3xl` `frost-popover` shell, `bg-gray-0/70 backdrop-blur(4px)` scrim, content fade + 96→100 zoom on open. Search input is the visual header (`srOnlyHeader=true` on Dialog so Radix `Title`/`Description` stay screen-reader-only). Items: `h-11 rounded-md px-2.5 text-sm font-medium` with a 28px `frost-icon-tile` leading slot + a `Kbd ↵` chip that fades in on the cmdk-selected row.
  - **AppShell wiring**: `paletteOpen` state lifted to `AppShell`, global `keydown` listener intercepts `⌘K` / `Ctrl+K` and toggles. Closes on every route change. Sidebar Search button (previously a no-op) now calls `onOpenPalette()`.
  - **Default command set**: **Actions** (New chat → `/`, Cycle theme via `useTheme()`, Sign out via `authClient.signOut()`) + **Navigate** (every entry in `SECTION_NAV` + `PERSONAL_NAV` + `Settings`). Each item carries `keywords` for fuzzy matching beyond the visible label.
  - **Styleguide**: `/styleguide#command-palette` ships a `CommandPaletteSection` with a trigger button + a self-contained palette that records the last picked item — reviewable in isolation.
  - **A11y note**: Radix initially warned about missing `Description` because we hid the header. Fixed by always rendering a default `sr-only` Description ("Type to search; use arrow keys to navigate; press Enter to select.") when no description is supplied.

## How to resume after a context compaction

1. Run `pnpm dev` from `/Users/yash/Developer/self/alfred` and visit `http://localhost:3000/styleguide`.
2. Compare the page against `references/dimension-dev/_live/baseline-2026-05-18-rewrite/styleguide-v3.png` — that's the canonical "Stage 1 done" snapshot.
3. The Stage-1 button recipe is verified against a live Dimension button — see `evaluate_script` output recorded in this conversation, captured 2026-05-18.
4. To continue at Stage 1 next-primitive, pick the next unchecked item in §Stage 1. Build it in `apps/web/src/components/ui/<name>.tsx`, register in `apps/web/src/components/ui/index.ts`, add a section in `apps/web/src/routes/styleguide.tsx`.
5. For Stage 2, start with `apps/web/src/routes/integrations.tsx` — it has the biggest current visual gap and is the most testable end-to-end (rows, search input, category grouping).

## Open questions / decision points

1. **`/styleguide` access control**: open by default. May want to gate behind `import.meta.env.DEV` or hide from production build before shipping.
2. **Greeting copy capitalization** (Title vs sentence): defer to home-route pass.
3. **MCP servers section in `/integrations`**: build empty section now or wait for m14?
4. **Existing `Button` in `apps/web/src/lib/ui.tsx`**: kept in place temporarily; routes migrate to the new `@/components/ui` primitive during their Stage 2 pass. Don't break callers in Stage 1.
5. **Spinner for `loading` state**: Button currently fades text to transparent when `loading=true` but doesn't render a spinner. Add when we pick a spinner primitive (could be the same one used elsewhere).
6. **Light mode**: Dimension is dark-only. Stage 0 left the OKLCH light-mode tokens intact for compat with existing routes, but the new Dimension primitives are dark-first. Stage 2 will reconcile.
7. **Radix opt-in** — _resolved 2026-05-18 (Stage 3)._ Decision: split path. Switch + Tabs stay hand-rolled (no a11y gap surfaced in Stage 2). Dialog + CommandPalette ship on `@radix-ui/react-dialog` + `cmdk` because the focus trap / portal / scroll-lock / cmdk fuzzy matching weren't worth re-implementing. Tooltip + Popover, if/when needed, should also be Radix-backed.
8. **Sidebar dark-mode reconciliation**: the sidebar's nav rows still use Tailwind's `bg-accent` / `text-muted-foreground` semantic tokens (theme-aware). Recon §3.7 wanted an "inner row-hover" pseudo-fill at `bg-[#131313]` to match Dimension. Deferred until we explicitly drop light-mode support in app-shell — adopting `gray-N` tokens directly would break light mode the same way the redesigned routes already do. Worth a one-shot pass once the light-mode question (open Q #6) is decided.

## Baseline evidence

Captured 2026-05-18:

- `_live/baseline-2026-05-18-rewrite/home-before.png` — `/` route before any work
- `_live/baseline-2026-05-18-rewrite/home-after-stage0.png` — `/` route after Stage 0 (body bg now `#0c0c0c`)
- `_live/baseline-2026-05-18-rewrite/styleguide-v3.png` — full styleguide after Stage 1 (canonical reference)
- `_live/baseline-2026-05-18-rewrite/styleguide-buttons-closeup.png` — button section viewport
- `_live/baseline-2026-05-18-rewrite/dimension-upgrade-button-reference.png` — live Dimension button for comparison

## Files added / changed in this pass

```
apps/web/src/index.css                            (Stage 0: tokens, frost-border, motion)
apps/web/src/components/ui/button.tsx             (Stage 1a)
apps/web/src/components/ui/icon-button.tsx        (Stage 1a)
apps/web/src/components/ui/input.tsx              (Stage 1b — 2026-05-18 batch 2)
apps/web/src/components/ui/textarea.tsx           (Stage 1b)
apps/web/src/components/ui/switch.tsx             (Stage 1b)
apps/web/src/components/ui/tabs.tsx               (Stage 1b)
apps/web/src/components/ui/card.tsx               (Stage 1b)
apps/web/src/components/ui/frost-panel.tsx       (Stage 1b)
apps/web/src/components/ui/avatar.tsx             (Stage 1b)
apps/web/src/components/ui/kbd.tsx                (Stage 1b)
apps/web/src/components/ui/status-dot.tsx         (Stage 1b)
apps/web/src/components/ui/index.ts               (re-exports)
apps/web/src/routes/styleguide.tsx                (sections per primitive)
apps/web/src/routes/integrations.tsx              (Stage 2a — rewrite)
apps/web/src/routes/workflows.tsx                 (Stage 2b — rewrite)
apps/web/src/routes/skills.tsx                    (Stage 2b — rewrite + instant-nav)
apps/web/src/routes/skills.$slug.tsx              (Stage 2b — rewrite)
apps/web/src/lib/eden.ts                          (credentials: 'include')
apps/web/src/routes/library.tsx                   (Stage 2c — rewrite)
apps/web/src/routes/settings.tsx                  (Stage 2c — new route)
apps/web/src/lib/app-shell.tsx                    (Stage 2c — Settings nav row, drop Agent surfaces filler; Stage 3 — palette wiring)
packages/api/src/modules/skills/routes.ts         (Optional name/prompt + poke)
apps/web/src/components/ui/dialog.tsx             (Stage 3)
apps/web/src/components/ui/command-palette.tsx    (Stage 3)
apps/web/package.json                             (Stage 3 — @radix-ui/react-dialog + cmdk)
apps/web/src/routes/notes.tsx                     (Stage 2d — rewrite)
apps/web/src/routes/memory.tsx                    (Stage 2d — rewrite)
apps/web/src/routeTree.gen.ts                     (auto)
references/dimension-dev/REWRITE_PROGRESS.md      (this file)
```

The legacy `apps/web/src/lib/ui.tsx` — `Button`, `Input`, `Textarea`, `Pill`, `Card`, etc. — is untouched. It still serves the existing routes. Each route gets migrated as part of its Stage 2 pass.

## Log

- **2026-05-18 morning** — Recon doc + evidence captured.
- **2026-05-18 afternoon** — Brand color locked to purple. Stage 0 + Stage 1a (Button + IconButton + /styleguide) landed. `frost-border` recipe verified live against Dimension Upgrade Plan button.
- **2026-05-18 evening** — Stage 1b: Input, Textarea, Switch, Tabs, Card, FrostPanel, Avatar, Kbd, StatusDot. Switch + Tabs hand-rolled (no Radix dep) — open question whether to migrate later. Type-check clean. Visual review captured at `_live/baseline-2026-05-18-rewrite/styleguide-v4-*.png`. `/styleguide` is now the complete Stage 1 kit for Stage 2 consumers.
- **2026-05-18 late** — Stage 2a `/integrations` rewrite landed. Centered title + search + five sections + verb-on-button + live filter + MCP placeholder. Baselines saved to `_live/baseline-2026-05-18-rewrite/integrations-{before,v1,v1-search-google,v1-empty,v1-hover-gmail}.png`. Type-check clean. Hover state verified visually.
- **2026-05-18 night** — Stage 2b `/workflows` + `/skills` + `/skills/$slug` rewritten end-to-end. Baselines: `workflows-{before,v1,v2,after}.png`, `skills-{before,v1,after}.png`, `skill-detail-{v1,v2,history-v1,draft-v1,draft-v2,after}.png`. Three off-rewrite items also landed because the Create-Skill UX required them: (1) `POST /api/skills` now accepts optional `name` / `prompt` and fires a Replicache poke for empty drafts; (2) eden treaty client passes `credentials: 'include'` (latent cross-origin auth bug); (3) `/skills` parent route now renders `<Outlet />` for child matches via `useChildMatches()` — the detail page was silently broken before. Type-check clean. End-to-end Create → instant nav → editor verified.
- **2026-05-18 late night** — Stage 2c `/library` rewrite + `/settings` new route + composer mask-gradient fade + sidebar Settings entry. Library uses pill-filters + search + party-popper empty state (no artifact producer yet). Settings is a left-aligned two-column inner-nav + panel layout with User / Integrations / Notifications / Preferences / Danger sections — Theme + Logout are real, others stub for m13. Composer textarea now fades the top + bottom 12px via a `mask-image` CSS rule on `.composer-editor`. Sidebar `Agent surfaces` filler card replaced with a `Settings` `NavLink` pinned to the footer. Baselines: `library-v1.png`, `settings-{user,preferences,notifications,danger}-v1.png`, `chat-composer-mask-v1.png`. Type-check clean.
- **2026-05-18 — Stage 2d (`/notes` + `/memory` migration)** — Migrated the last two legacy routes off `lib/ui.tsx`. `/notes` uses the home-composer chrome trimmed to mic + send, with the composer + Recent section vertically aligned in a `max-w-[688px]` column. `/memory` keeps a `max-w-3xl` body so confirmed-fact rows stay readable; proposed cards use the new `Button` + a `StatusDot`-based `ConfidenceChip`; confirmed list is one `Card` wrapping a `divide-y` `<ul>`; toast stack uses `frost-popover`. Remaining `lib/ui.tsx` consumers are now only `lib/skills-ui.tsx` (Pill — documented carve-out in open Q #4) and `routes/index.tsx` (`ToolButton` — home composer). Note submission verified live end-to-end in Chrome; type-check clean (10/10 turbo). Baselines: `notes-{before,v1,v2,v2-after-submit}.png`, `memory-{before,v1,v2}.png` under `_live/baseline-2026-05-18-rewrite/`.
- **2026-05-18 — Stage 3 (search modal)** — Built `Dialog` (Radix Dialog wrapper) + `CommandPalette` (cmdk-based) primitives. Wired `⌘K` / `Ctrl+K` and the sidebar Search button (previously a no-op) to open an `AppCommandPalette` mounted at `AppShell` scope. Default commands cover Actions (New chat / Cycle theme / Sign out) + Navigate (every section nav + personal nav + Settings). Each item carries `keywords` for richer fuzzy matching. Styleguide section at `/styleguide#command-palette` ships a self-contained reviewable instance. Closed REWRITE_PROGRESS open Q #7 (Radix-for-modals, hand-rolled-for-Switch/Tabs); opened Q #8 (sidebar light-mode reconciliation). Type-check clean (10/10 turbo). Verified live in Chrome on :3000 — open/filter/Enter-to-navigate/Esc-to-close all functional, console clean after the Radix `Description` warning was fixed by always rendering a sr-only Description. Baselines: `command-palette-{v1,v1-filter,v2}.png`, `styleguide-command-palette-v1.png` under `references/dimension-dev/_live/baseline-2026-05-18-rewrite/`.
- **2026-05-19 — Dimension preview PR pass** — Added the active chat preview route work on `codex/dimension-preview-ui`: real TipTap/ProseMirror composer, Radix Accordion for tool/thought/search disclosures, local preview turns, captured Sycamore artifact iframe pages, and the `ArtifactPageFrame` scaler. Home chat was then upgraded to TipTap, Dimension-style composer controls, connected-tools tray, right rail, setup/banner weather-video hook, and a shared `WeatherVideoSurface` pointing to `/videos/partly_cloudy.mp4` with CSS fallback. Type-check clean after each commit. Current known asset gap: an owned/recreated `apps/web/public/videos/partly_cloudy.mp4` is still needed for true rail/banner parity.
- **2026-05-19 — Full UI reproduction roadmap** — Added [`ui-reproduction-roadmap-2026-05-19.md`](./ui-reproduction-roadmap-2026-05-19.md), a route-by-route matrix covering home, chat states, artifacts, integrations, workflows, skills, library, settings, onboarding, mobile, modals, and quick-rail sub-states. It also records browser-captured frontend signals from the minified Next route chunk/CSS bundles and defines P0/P1/P2 implementation order plus acceptance protocol.
- **2026-05-19 — UI execution queue** — Added [`ui-execution-queue-2026-05-19.md`](./ui-execution-queue-2026-05-19.md), which splits the full roadmap into can-do-now, asset/capture-blocked, and deferred buckets. The recommended first implementation slice is extracting a shared Dimension composer shell because home and chat already duplicate that surface and later menu/model/approval polish depends on it.
- **2026-05-19 — Shared composer shell** — Added `apps/web/src/components/dimension-composer-shell.tsx` and moved both home and chat composers onto the same shell/toolbar/button/model-chip primitives. The home composer keeps its mention handling and connected-tools tray; the chat composer keeps local preview submission. Targeted oxlint and `pnpm --filter web check-types` are clean. Browser verification covered `/chat/sycamore?artifact=1` and authenticated `/` with a temporary mock API.
- **2026-05-19 — Composer menus** — Added `@radix-ui/react-dropdown-menu` and `@radix-ui/react-popover`, then upgraded `DimensionComposerShell` with frosted context, model, and overflow menus. The home composer now exposes `+` context actions, a local Alfred/Alfred Pro picker, and composer options; the chat composer has matching chat-specific context/model/options surfaces. Fixed the shared icon button to forward refs/props so Radix triggers open correctly. Targeted oxlint and `pnpm --filter web check-types` are clean; browser verification covered home context/model/overflow menus and chat context menu.
- **2026-05-19 — Chat preview states** — Added query-addressable chat UI states for Dimension parity: default completed, all-expanded (`?state=all-expanded`), streaming/thinking (`?state=streaming`), active tool (`?state=active-tool`), and rich content/code/table (`?state=rich-content`). Also let `?artifact=1` force the artifact panel for any chat thread id. Targeted oxlint and `pnpm --filter web check-types` are clean; browser verification covered all five states with artifact panel enabled and no console errors.
- **2026-05-19 — Artifact panel controls** — Upgraded the in-chat artifact panel with Dimension-style document header metadata, status strip, icon toolbar, page thumbnail rail, page selection state, completed/generating/empty variants, and unresolved-page placeholder. `?artifactState=generating` and `?artifactState=empty` now reproduce the PDF-generation and no-pages states; completed remains the default. Also recorded the weather-background observation: Dimension appears to vary weather media by time/weather, so Alfred needs the full owned video set plus condition mapping for final parity. Targeted oxlint and `pnpm --filter web check-types` are clean; browser verification covered completed/generating/empty artifact states, page selection, and no console errors.
- **2026-05-19 — Connect tools modal** — Added `apps/web/src/components/connect-tools-dialog.tsx`, a Radix Dialog-backed provider picker with search, connected count, grouped provider rows, connected/available status pills, and integration-detail links. Wired the home composer `Connect Your Tools` tray, setup nudge, and composer `+` menu connect action to open it locally instead of immediately navigating away. Targeted oxlint and `pnpm --filter web check-types` are clean; browser verification opened the modal from the tray and confirmed provider rows/search/control structure with no console errors.
- **2026-05-19 — Library populated/type menu** — Added presentation and spreadsheet fixture artifacts so `/library` demonstrates every captured artifact type instead of only PDF/document. Replaced the local absolute type menu with a Radix Popover-backed type filter using Dimension-style checkbox rows, selected-count trigger text, and clear action. Targeted oxlint and `pnpm --filter web check-types` are clean; browser verification covered populated cards, type popover options, presentation filtering, and no console errors.
- **2026-05-19 — Workflow detail tabs/share dialog** — Upgraded `/workflows/$workflow` from a simple plan/empty-tab preview to Dimension-style Overview, Triggers, History, and Approvals tabs. Overview now shows status/cadence/trigger metrics, Triggers has enabled trigger conditions, History has recent-run fixture rows, Approvals has policy rows, and Share opens a Radix Dialog-backed private-link preview. Targeted oxlint and `pnpm --filter web check-types` are clean; browser verification covered every tab plus the Share dialog with no console errors.
