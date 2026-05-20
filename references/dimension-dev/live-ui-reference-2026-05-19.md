# Dimension live UI reference — 2026-05-19

Captured from the authenticated Chrome tab at `https://dimension.dev/chat` on 2026-05-19, one day before the announced 2026-05-20 shutdown. This file is the current build reference for reproducing the Dimension-inspired UI in Alfred with the local primitives in `apps/web/src/components/ui/`.

Evidence from this pass:

- Screenshot: [`screenshots/46-live-chat-home-2026-05-19.png`](./screenshots/46-live-chat-home-2026-05-19.png)
- Accessibility tree: [`snapshots/live-chat-home-2026-05-19.txt`](./snapshots/live-chat-home-2026-05-19.txt)
- Computed styles and loaded assets: [`live-chat-home-2026-05-19.styles.json`](./live-chat-home-2026-05-19.styles.json)

Companion references that remain canonical:

- [`dimension-design-reference-2026-05-18.md`](./dimension-design-reference-2026-05-18.md) — tokens and primitive recipes
- [`home-fidelity-gaps-2026-05-18.md`](./home-fidelity-gaps-2026-05-18.md) — Alfred vs Dimension home/chat deltas
- [`final-live-ui-recon-2026-05-18.md`](./final-live-ui-recon-2026-05-18.md) — broad final-pass preservation
- [`alfred-replication-map.md`](./alfred-replication-map.md) — route/component translation map
- [`radix-route-blueprints-2026-05-19.md`](./radix-route-blueprints-2026-05-19.md) — route-by-route Radix-equivalent DOM blueprints
- [`chat-meeting-prep-reference-2026-05-19.md`](./chat-meeting-prep-reference-2026-05-19.md) — meeting-prep card/dialog addition, keyboard behavior, and HTML repro
- [`weather-and-route-notes-2026-05-19.md`](./weather-and-route-notes-2026-05-19.md) — weather/right-rail specifics and final route traversal notes for integrations, workflows, skills, library, and settings
- [`integration-google-drive-detail-2026-05-19.md`](./integration-google-drive-detail-2026-05-19.md) — sanitized provider-detail capture for `/integrations/google_drive`, including related Google setup rows and capability labels
- [`integrations-overall-design-2026-05-19.md`](./integrations-overall-design-2026-05-19.md) — consolidated integration catalog/detail design across connected, unconnected, related-provider, custom, and coming-soon states
- [`chat-tool-rendering-sycamore-2026-05-19.md`](./chat-tool-rendering-sycamore-2026-05-19.md) — live Sycamore thread capture for completed research runs, nested tool accordions, web-result rows, citations, reaction buttons, composer state, and current no-iframe/PDF status
- [`REWRITE_PROGRESS.md`](./REWRITE_PROGRESS.md) — what has already landed locally

## Source-map status

Source maps are not exposed enough to rely on them.

The current live page loads Next build `2Yg6GmRb0YtGO-YJVw6mf` with deployment query `dpl_HfumqwUvw2j9zVXSutQ6y2HiZDC4`. The inspected JS and CSS assets did not include `sourceMappingURL` comments. The chat page chunk is readable only as minified webpack output: useful for confirming class names, component strings, icon SVGs, video asset names, network procedure names, and Tailwind recipes, but not a maintainable source reconstruction.

Use this hierarchy instead:

1. Screenshot and visible layout for geometry.
2. Accessibility snapshot for copy, landmarks, labels, and interaction affordances.
3. Computed styles for exact colors, dimensions, typography, radii, shadows, and media.
4. Minified bundle strings only as a secondary check for class recipes and asset names.

## Live build identity

- URL: `https://dimension.dev/chat`
- Title: `New Chat - Dimension`
- Viewport captured: `1728 × 936`, DPR `2`
- Body font: `"DM Sans", "DM Sans Fallback", ui-sans-serif, system-ui, sans-serif`
- Body background: `rgb(12, 12, 12)`
- Body text: `rgb(237, 237, 237)`
- Top shutdown banner copy: `Dimension is winding down on May 20, 2026. We'll handle cancellations and refunds automatically.`

## Visible surface inventory

This is every major UI part visible in the 2026-05-19 `/chat` capture.

| Surface | Live Dimension detail | Alfred primitive/build target |
| --- | --- | --- |
| Top shutdown banner | 36px top region above the app frame. Amber/brown notice surface, text + `Learn more` link. | App-shell banner, plain div. Not a Radix primitive. |
| Left sidebar shell | App nav below banner, rows inset to ~220px. Profile/collapse controls above nav, Settings pinned at bottom. | `apps/web/src/lib/app-shell.tsx`; use existing `NavLink` rows plus `Kbd`. |
| Sidebar nav rows | `New Chat` with `⇧ O`, Search with `K`, then Integrations, Workflows, Skills, Library, referral banner. Rows are ~40px tall, `rounded-xl`, quiet hover fill. | Existing app shell nav. Search opens `CommandPalette`. |
| Center date | `Tuesday, May 19th`; 18px/28, `rgba(255,255,255,0.5)`, slight negative tracking in live CSS. | Home route text utility. Keep ordinal date formatter. |
| Center greeting | `Good Morning, Yash`; 36px/40-ish display treatment, white-to-muted gradient text. | `heading-display` utility in `index.css`. |
| Composer outer | Centered width ~656px including controls row. Editor min-height 50px, max-height 320px. Outer material is dark translucent, `rounded-2xl`. | Home composer in `routes/index.tsx`; eventually make a `Composer` component. |
| Editor placeholder | `Type and press enter to start chatting...` inside ProseMirror/Tiptap editor. | Existing textarea placeholder until rich composer lands. |
| Add/context button | Icon-only button at lower-left of composer, menu trigger. | `IconButton`; future Radix Popover/Menu when file attach exists. |
| Auto toggle | `71 × 31`, `rounded-[10px]`, gradient `#0f0f0f -> #1e1e1e`, 4px blur, label `Auto`. Off/on state is visual only in this capture because credits are exhausted. | Existing home approval toggle or new compact toggle. If semantics differ, keep Dimension chrome but Alfred-specific copy/behavior. |
| Credits exhausted pill | Copy `Credits have exhausted` plus `Upgrade` link appears between Auto and model controls. | Alfred can omit unless billing exists. |
| Model picker | `107 × 29`, `rounded-lg`, gradient `#0c0c0c -> #151515`, text `Dimension`, subtle inset shadow, blur, 0.5px transparent border/frost. | `Button`/custom model trigger. Use Radix Select/Popover when active. |
| Mic button | Icon-only dark control between model picker and send. | `IconButton`, rounded-full override. |
| Send button | Disabled in capture. 32px disk in Dimension grammar: gray-to-white gradient and frost-border when enabled; disabled opacity. | `Button variant="send"` already exists. |
| Connect Your Tools row | Attached below composer: `656 × 46`, `rounded-b-2xl`, `-mt-1`, `px-4`, `pt-3.5`, `pb-3`, provider icons + label. | Route-specific row; use brand glyphs from `integration-icons.tsx`. |
| Upcoming meeting card | Below composer: section label `UPCOMING MEETING`, title `Eng standup`, time range, `Join` button. | Future quick/context card. Use `Card` or `FrostPanel` depending whether it is generated/actionable. |
| Upgrade banner | Absolute bottom overlay in center column, ~655 × 72, `rounded-[24px]`, `partly_cloudy.mp4` behind text, white CTA `Upgrade Plan`. | Alfred setup/integration nudge. Use `Button variant="white"` and owned media/animated fallback. |
| Right quick rail | Right column `348 × 882` in this viewport, inset 9px from right and 45px from top, `rounded-3xl`, video-backed with `partly_cloudy.mp4` at `0.5` playback rate. | `QuickAccessRail`; use app-owned media or animated CSS fallback. |
| Rail weather header | `Bhubaneswar 30°`, no icon, then `To Do` at 24px/32, weight 500. | Rail header component. Do not add `Local weather` label. |
| Rail mode tabs | Three-icon segmented control: todo, envelope, meeting/video. Active tab is selected with subtle translucent highlight. | `Tabs variant="segmented"` with icon-only items. |
| Rail filter row | `All` tab selected, pen/edit icon button. Uses plus-lighter blend over video. | Small local row; `IconButton` for edit. |
| Add todo row | Checkbox at left, multiline textarea placeholder `Add new to do`, transparent chrome. | `Checkbox` primitive still missing; use Radix Checkbox when adding. `Textarea variant="inline"` for input. |
| Suggestions section | `SUGGESTIONS` label with icon prefix, left-aligned; includes live suggestion `Reply to Sakshi on missing deals debug task`. | Quick rail task suggestions list. Use rows/buttons, not cards-within-cards. |
| Morning Briefing button | Bottom/right-rail affordance to open daily briefing. | Quick rail action button; map to briefing workflow route/modal later. |

## Exact style anchors from live capture

These values came from `live-chat-home-2026-05-19.styles.json`.

| Element | Rect | Key computed style |
| --- | --- | --- |
| Body | `1728 × 936` | `background rgb(12,12,12)`, `color rgb(237,237,237)`, DM Sans, `16/24 400` |
| Main frame | `1728 × 900`, starts at y=36 | `display:flex`, `overflow:hidden` |
| Sidebar nav | `220 × 304`, x=10 y=102 | `gap:4px` |
| Date | `660 × 28`, x=471 y=306 | `18/28 400`, `rgba(255,255,255,.5)` |
| Auto toggle | `71.4 × 31`, x=498 y=484 | `rounded 10px`, `linear-gradient(rgb(15,15,15), rgb(30,30,30))`, `backdrop-filter: blur(4px)` |
| Model picker | `107.2 × 29`, x=946 y=485 | `rounded 8px`, `padding 4px 8px`, gradient `#0c0c0c -> #151515`, inset `0 0 4px rgba(0,0,0,.4)` |
| Connect row | `656 × 46`, x=473 y=524 | `padding 14px 16px 12px`, `rounded-bottom 16px`, `margin-top -4px` |
| Upgrade video | `655 × 72`, x=474 y=823 | `partly_cloudy.mp4`, `object-cover`, `rounded 24px`, `playbackRate .5` |
| Right rail video | `348 × 882`, x=1371 y=45 | `partly_cloudy.mp4`, `object-cover`, `playbackRate .5` |
| Rail title | `To Do`, `120 × 32` | `24/32 500`, white |
| Suggestions header | `308 × 25` | `display:flex`, `gap 4px`, `mix-blend-plus-lighter` |
| Add todo textarea | `258 × 24` | transparent, `14/20 400`, placeholder white/50 |

## Radix/primitives build map

Existing local primitives already cover most of the visual grammar:

- `Button`: primary, white, destructive, ghost, send.
- `IconButton`: square or rounded override for composer/rail utility buttons.
- `Input` and `Textarea`: search, card, inline.
- `Tabs`: segmented rail tabs, underline detail tabs, pill filters.
- `Dialog` and `CommandPalette`: Radix Dialog + cmdk for search modal.
- `Card` and `FrostPanel`: plain work rows vs generated/inspectable surfaces.
- `Avatar`, `Kbd`, `StatusDot`: sidebar/profile, shortcuts, live statuses.

Missing or worth adding only when a consumer needs them:

- `Popover` / `Menu`: use Radix Popover or Dropdown Menu for composer `+`, model picker, mention menu shell, and row kebabs.
- `Checkbox`: use Radix Checkbox for the quick-rail todo row and task completion state.
- `Select`: use Radix Select only if the model picker becomes a real listbox; otherwise a Popover is enough.
- `Tooltip`: useful for icon-only rail/sidebar controls.

Implementation note: Switch and Tabs are currently hand-rolled locally. That is acceptable for current surfaces, but the model picker, attach menu, and checkbox should use Radix primitives because focus management and keyboard behavior matter more there.

## DOM reconstruction stance

The goal should be "Radix-equivalent DOM and behavior", not byte-for-byte DOM cloning.

Radix gives us the important contract: roles, ARIA attributes, keyboard behavior, focus trapping, portals, data-state attributes, and predictable trigger/content composition. Dimension's exact wrapper DOM still comes from their custom React components, Tailwind class composition, Framer Motion wrappers, and TipTap editor. Since readable source maps are not exposed, the exact component source tree is not recoverable. But the visible DOM can be reconstructed closely enough if each interactive region is mapped to the matching primitive.

Current Alfred Radix state:

| Interaction | Dimension-like primitive | Alfred today | Action |
| --- | --- | --- | --- |
| Search / command palette | Radix Dialog + cmdk | Installed and wrapped as `Dialog` + `CommandPalette` | Keep |
| Modal dialogs | Radix Dialog | Installed | Keep |
| Rail tabs / detail tabs | Radix Tabs-like DOM | Hand-rolled `Tabs` | OK visually; migrate to `@radix-ui/react-tabs` only if keyboard parity matters |
| Todo checkbox | Radix Checkbox-like DOM | Missing | Add `@radix-ui/react-checkbox` wrapper |
| Composer `+` menu | Radix Popover or Dropdown Menu | Missing | Add when file/menu surface ships |
| Model picker | Radix Popover or Select | Missing | Prefer Popover for Dimension-style custom row layout |
| Kebab menus | Radix Dropdown Menu | Missing | Add with shared `frost-popover` material |
| Tooltips | Radix Tooltip | Missing | Add for icon-only controls |
| Rich composer | TipTap / ProseMirror | Alfred uses textarea | Separate migration; Radix does not solve this |

## Radix-equivalent `/chat` DOM blueprint

This is the practical component tree to build from. Class recipes come from the tables above and `dimension-design-reference-2026-05-18.md`.

```tsx
<AppShell>
  <ShutdownBanner />

  <main className="dimension-app-frame">
    <Sidebar>
      <ProfileTrigger />
      <NavLink href="/">New Chat <Kbd>⇧ O</Kbd></NavLink>
      <button onClick={openCommandPalette}>Search <Kbd>K</Kbd></button>
      <NavLink href="/integrations">Integrations</NavLink>
      <NavLink href="/workflows">Workflows</NavLink>
      <NavLink href="/skills">Skills</NavLink>
      <NavLink href="/library">Library</NavLink>
      <ReferralBanner />
      <SidebarFooter>
        <NavLink href="/settings">Settings</NavLink>
      </SidebarFooter>
    </Sidebar>

    <section className="home-center-column">
      <p className="home-date">Tuesday, May 19th</p>
      <h1 className="heading-display">Good Morning, Yash</h1>

      <ComposerShell>
        <ComposerEditor placeholder="Type and press enter to start chatting..." />
        <ComposerToolbar>
          <Popover.Root>
            <Popover.Trigger asChild>
              <IconButton aria-label="Add context" />
            </Popover.Trigger>
            <Popover.Content className="frost-popover rounded-2xl">
              <MenuRow icon="paperclip">Add photos & files</MenuRow>
              <MenuRow icon="@">Mention</MenuRow>
            </Popover.Content>
          </Popover.Root>

          <AutoToggle />
          <CreditsNotice />

          <Popover.Root>
            <Popover.Trigger asChild>
              <button className="dimension-model-trigger">Dimension</button>
            </Popover.Trigger>
            <Popover.Content className="frost-popover rounded-2xl">
              <ModelRow selected title="Dimension" subtitle="Great for almost everything." />
              <ModelRow title="Dimension Pro" subtitle="Our flagship agent for complex tasks." />
            </Popover.Content>
          </Popover.Root>

          <IconButton aria-label="Dictate" />
          <Button variant="send" size="md" aria-label="Send" />
        </ComposerToolbar>
      </ComposerShell>

      <ConnectToolsRow />
      <UpcomingMeetingCard />
      <UpgradeBanner />
    </section>

    <QuickAccessRail>
      <WeatherVideo />
      <RailHeader location="Bhubaneswar" temperature={30} title="To Do" />

      <Tabs.Root value="todo">
        <Tabs.List className="dimension-rail-tabs">
          <Tabs.Trigger value="todo"><BoxCheckIcon /></Tabs.Trigger>
          <Tabs.Trigger value="email"><EnvelopeIcon /></Tabs.Trigger>
          <Tabs.Trigger value="meetings"><VideoIcon /></Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="todo">
          <TodoFilterRow />
          <AddTodoRow>
            <Checkbox.Root className="dimension-checkbox">
              <Checkbox.Indicator />
            </Checkbox.Root>
            <Textarea variant="inline" placeholder="Add new to do" />
          </AddTodoRow>
          <SuggestionList />
          <MorningBriefingButton />
        </Tabs.Content>

        <Tabs.Content value="email">
          <RailEmptyState title="All done!" subtitle="No pending email drafts." />
        </Tabs.Content>

        <Tabs.Content value="meetings">
          <RailEmptyState title="All done!" subtitle="You have no meetings scheduled for today." />
        </Tabs.Content>
      </Tabs.Root>
    </QuickAccessRail>
  </main>

  <CommandPalette />
</AppShell>
```

Key implementation rule: use `asChild` on Radix triggers whenever the visual primitive is already our local `Button`, `IconButton`, or custom trigger. That preserves Alfred's styling while letting Radix own the behavior and ARIA.

## Reconstruction priority

1. Preserve the center composer exactly enough: dimensions, Auto pill, model trigger, send disk, connect-tools row, greeting/date.
2. Preserve the right quick rail: weather video/material, three mode tabs, add-todo row, suggestion rows, emails/meetings empty states.
3. Preserve global shell rhythm: shutdown/system banner slot, left nav order, command palette, Settings pinned at bottom.
4. Preserve interaction overlays: connect-tools modal, `@` mention menu, model picker popover, route-specific dialogs.
5. Treat source bundle strings as confirmation only. The source maps are not available; the live DOM and computed styles are the reliable reference.
