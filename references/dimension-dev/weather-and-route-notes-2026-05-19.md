# Dimension weather rail and route traversal notes - 2026-05-19

Captured from the authenticated live app on 2026-05-19 as a final preservation pass for the right-side weather/todo rail and several secondary routes. This file is intentionally sanitized: it records UI structure, styles, behavior, and accessibility requirements, but not private account content from the live session.

Companion files:

- [`live-ui-reference-2026-05-19.md`](./live-ui-reference-2026-05-19.md) - main `/chat` visual inventory
- [`radix-route-blueprints-2026-05-19.md`](./radix-route-blueprints-2026-05-19.md) - route-by-route Radix rebuild map
- [`chat-meeting-prep-reference-2026-05-19.md`](./chat-meeting-prep-reference-2026-05-19.md) - meeting-prep card/dialog reference

## Evidence boundary

The live app is a minified Next.js app without usable source maps. Treat the notes below as a rebuild contract, not a component-source reconstruction. The useful evidence is:

- Accessibility roles and names exposed in Chrome's a11y tree.
- Computed style values from the live DOM.
- Network and media assets loaded by the live page.
- Visible behavior while moving through `/chat`, `/integrations`, `/workflows`, `/skills`, `/library`, and `/settings`.

## Right rail weather and todo panel

Observed on `/chat` at viewport `1728 x 936`, device scale factor `2`.

DOM target:

```tsx
<aside className="quick-rail" aria-label="Quick access">
  <video
    aria-hidden="true"
    muted
    loop
    playsInline
    src={weatherVideoFor(condition)}
  />

  <header>
    <p className="rail-weather">{city} {temperature}°</p>
    <h2>To Do</h2>
  </header>

  <Tabs.Root value={mode}>
    <Tabs.List aria-label="Quick access mode">
      <Tabs.Trigger value="todos" aria-label="Todos"><CheckSquareIcon /></Tabs.Trigger>
      <Tabs.Trigger value="emails" aria-label="Email"><MailIcon /></Tabs.Trigger>
      <Tabs.Trigger value="meetings" aria-label="Meetings"><VideoIcon /></Tabs.Trigger>
    </Tabs.List>

    <Tabs.Content value="todos">
      <Tabs.Root value={filter}>
        <Tabs.List aria-label="Todo filter">
          <Tabs.Trigger value="all">All</Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>

      <form className="add-todo-row">
        <Checkbox aria-label="Mark new todo complete" />
        <Textarea placeholder="Add new to do" />
      </form>

      <SuggestionsSection />
      <button>Morning Briefing</button>
    </Tabs.Content>
  </Tabs.Root>
</aside>
```

### Media behavior

- The right rail uses a full-size `<video>` as the background: `348 x 882` in this viewport, object-fit cover.
- The same weather video also appears behind the bottom upgrade/setup banner at about `655 x 72`, clipped to `rounded-[24px]`.
- Both visible videos were muted, looped, `playsInline`, and slowed to `playbackRate = 0.5`.
- The observed weather asset was `https://dimension.dev/videos/partly_cloudy.mp4`.
- Bundle/media evidence also points to condition-specific assets: `sunny.mp4`, `partly_cloudy.mp4`, `cloudy.mp4`, `rainy.mp4`, `thunderstorm.mp4`, and `night.mp4`.
- Live calls observed around this surface include `/trpc/user.detectLocation` and `/trpc/user.refreshWeather`.

Alfred build note: the video must be decorative. Use `aria-hidden="true"` and do not let it enter the tab order. If Alfred does not ship video assets, keep the exact same DOM area and substitute a generated/owned loop or a static media-backed gradient, but do not replace it with a plain card.

### Style anchors

| Element | Observed geometry/style |
| --- | --- |
| Rail video | `348 x 882`, object cover, playback rate `0.5` |
| Weather text | `14px / 20px`, weight `700`, `rgba(255,255,255,.6)`, tracking class `tracking-[4%]`, `mix-blend-plus-lighter`; copy format `{City} {Temp}°` |
| Rail title | `To Do`, `24px / 32px`, weight `500`, white |
| Mode tab track | `172 x 40`, `bg-black/20`, `rounded-2xl` |
| Mode tabs | `56 x 36`, `rounded-[14px]`, padding `10px 20px`; active text white, inactive `rgba(255,255,255,.5)` |
| Filter row | `All` selected tab, about `32 x 24`, `14px / 20px`, plus-lighter blend |
| Checkbox | `16 x 16`, radius `4px`, white border, opacity `0.5`, plus-lighter blend |
| Add todo textarea | `258 x 24`, transparent, no border, `14px / 20px`, placeholder white at 50% |
| Morning Briefing | Full width bottom action, `348 x 57`, `px-5 py-4`, `16px` medium text, `bg-black/[0.1]`, top border `white/5` |

### Accessibility and keyboard contract

Dimension's live tree exposed one weak point: the icon-only rail tabs did not all have useful accessible names. Alfred should correct that while preserving the visual design.

Required behavior:

- The rail gets `aria-label="Quick access"` or a visible heading association.
- The decorative video has `aria-hidden="true"` and no controls.
- The mode control uses Radix Tabs or equivalent: `role="tablist"`, three `role="tab"` triggers, arrow-key navigation, and `aria-selected`.
- Every icon-only tab has an explicit `aria-label`: `Todos`, `Email`, `Meetings`.
- The add-todo checkbox has a label, even if visually hidden.
- The add-todo textarea remains reachable by `Tab` and submits only on an explicit user action or established composer shortcut.
- `Morning Briefing` is a real button and should open the briefing modal/view with focus moved into the new surface.

Acceptance checks:

1. At desktop width, the right rail stays clipped to the app shell, not the page body.
2. The video covers the rail without stretching or exposing blank edges.
3. `Tab` reaches the mode tabs, add-todo checkbox, textarea, edit action, suggestions, and briefing action in a predictable order.
4. Arrow keys move between tab triggers without scrolling the page.
5. Disabling/replacing weather data still preserves layout with `{City} {Temp}°` hidden or replaced by a neutral fallback, not a collapsed header.

## Cross-route traversal notes

These routes all retain the same authenticated app shell: shutdown/system banner, left sidebar, route content, and no right rail except the chat route.

### Shared route header

Most secondary routes use a centered page title with the same visual recipe:

- `40px / 48px`, weight `500`, tight tracking.
- Text gradient from solid near-white to muted gray via `bg-clip-text`.
- Search and primary CTA controls sit directly below or near the title, not in a separate toolbar card.

`/settings` is the exception: its title is left-aligned and paired with a settings-section nav.

### `/integrations`

Live structure:

- Centered `Integrations` H1 using the shared `40px / 48px` gradient title.
- Search input about `658 x 46`, `rounded-full`, `bg-[#1c1c1c]/50`, `14px / 20px`, left icon padding around `36px`.
- Section headers use `16px / 24px`, weight `500`, full content width, with about `16px` bottom margin.
- Integration rows are button-like cards, about `450 x 65` in a three-column layout, `p-3`, `rounded-2xl`, hover/focus fill `#181818`.
- Connected integrations are promoted to the top section; provider groups follow.

Radix/Alfred build:

- Search can be a plain `Input` unless it opens suggestions.
- Rows should be `<button>` or `<a>` depending on whether they open a provider detail route.
- Keep provider metadata shared with the `Connect Your Tools` modal to avoid drift.

### `/integrations/google_drive`

Follow-up authenticated Chrome capture added after the initial route traversal because the provider-specific pages were under-documented. See [`integration-google-drive-detail-2026-05-19.md`](./integration-google-drive-detail-2026-05-19.md) for the full sanitized reference.

Live structure:

- Same authenticated app shell and centered route content column; no right rail.
- Back link `All integrations`, provider header, and primary `Add Account` pill.
- Connected account table/list with `Connected`, `Date`, `Status`, and a destructive `Disconnect` action.
- Inline trust notice: `Your data is indexed & encrypted`.
- Google-specific setup rows for `Google Docs`, `Google Sheets`, and `Google Slides`, each with a trailing `Manage` affordance.
- Capability labels: `Read Files`, `Upload Files`, `Download Files`, `Create Folders`, `Share Files`, `Search Files`, `Manage Permissions`.
- Overview section plus `Smart File Operations` explanatory copy.

Radix/Alfred build:

- Implement provider detail routes with shared provider metadata and provider-specific related integrations.
- Use Radix `Dialog` for `Add Account` and `AlertDialog` for `Disconnect`.
- Avoid nested interactive controls in the related Google setup rows.

### `/workflows`

The current live route uses a card grid, not the earlier simple full-width row list.

Live structure:

- Centered `Workflows` H1 with the shared gradient title.
- `Create Workflow` CTA: primary purple/frost pill, about `148 x 40`, `rounded-full`, `15px / 22.5px`, `px-4 py-2`.
- Workflow items render as frosted gradient cards, about `334 x 244`, with `p-6`, `rounded-3xl`, background gradient `#181818 -> #131313`, subtle frost border, title text, preview/body copy, and a status/action pill.

Radix/Alfred build:

- The list itself does not need a Radix primitive.
- Card actions should be links into `/workflows/:id`.
- Kebab, sharing, and destructive actions belong in Dropdown/Dialog primitives on the detail route, not embedded into the card grid until needed.

### `/skills`

The live route mirrors `/workflows` structurally.

Live structure:

- Centered `Skills` H1 with the shared gradient title.
- `Create Skill` CTA: primary purple/frost pill, about `110 x 40`.
- Skill items render as frosted gradient cards, about `334 x 209`, `p-6`, `rounded-3xl`, with title and prompt preview text.

Radix/Alfred build:

- Cards should link to `/skills/:id`.
- Prompt previews must clamp safely so private or long source prompts do not break card height.
- Skill creation can start as a dialog or direct detail-route draft; Dimension's visual grammar supports either, but the route card grid should remain unchanged.

### `/library`

Live structure:

- The `All Types` trigger is a pill about `107 x 37`, `rounded-full`, frost border, dark gradient `#0c0c0c -> #151515`, inset shadow.
- Opening `All Types` renders a compact floating surface, about `250 x 238`, `rounded-2xl`, `rgba(16,16,16,.75)`, `backdrop-filter: blur(8px)`, frost border, and layered shadow.
- The opened surface exposes combobox/listbox semantics and a checklist of artifact types.
- Checkboxes are `16 x 16`, radius `4px`; checked state uses purple `rgb(83,59,229)` with a small inset white glow; unchecked state uses `rgb(28,28,28)`.

Radix/Alfred build:

- Use Radix Popover for the floating filter panel.
- Use cmdk or a small combobox/listbox only if filtering/searching within types is implemented; otherwise a Popover with Checkbox items is enough.
- Artifact opening from Library can be Dialog-based, while chat artifact previews should continue borrowing the right rail.

### `/settings`

Live structure:

- Left-aligned `Settings` route.
- Section nav buttons observed: `User`, `Billing`, `Plan`, `Features`, `Preferences`, `Referrals`.
- Section nav rows are about `176 x 28`, `py-1`, icon + label, `14px` medium text.
- Active row color is near-white (`rgb(237,237,237)`); inactive rows are muted (`rgb(160,160,160)`).
- Content panel includes account fields, preferred-mode tabs, switches, and a background/editor area.
- Mode tabs use `role="tab"`, height about `32px`, padding `6px 14px`, gap `8px`; active text is white, disabled/inactive states are muted with reduced opacity.
- Switches are about `44 x 24`, `rounded-full`; off background is `rgb(35,35,35)` with a frost border, on state should use the purple accent.

Radix/Alfred build:

- Use Tabs or roving button groups for the settings sections only if the URL/query state stays in sync.
- Use Radix Switch when adding real preferences.
- Treat profile/background content as private data. The reference to preserve is layout and control behavior, not literal copy.

## Reproduction checklist

When rebuilding these surfaces in Alfred, visit the following paths and verify against the contract above:

1. `/chat` - right rail weather media, todo tabs, add-todo row, suggestions, Morning Briefing action, meeting prep card/dialog.
2. `/integrations` - centered title, large rounded search, connected/provider sections, three-column interactive rows.
3. `/integrations/google_drive` - provider detail header, connected-account table, related Google setup rows, capabilities, overview, add/disconnect dialogs.
4. `/workflows` - centered title, primary create CTA, frosted card grid.
5. `/skills` - centered title, primary create CTA, frosted card grid with clamped prompt previews.
6. `/library` - `All Types` filter pill, popover geometry, checkbox states, artifact opening behavior.
7. `/settings` - left title, section nav, field rows, tabs, switches, and focus order.

Keyboard pass:

- `Tab` through each route from the sidebar into the main content.
- Use arrow keys inside tablists and filter popovers.
- Open and close popovers/dialogs with `Enter`, `Space`, and `Escape`.
- Confirm icon-only buttons have visible tooltip text or accessible names.
- Confirm focus returns to the trigger after every popover/dialog close.
