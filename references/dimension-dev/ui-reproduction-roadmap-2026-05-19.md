# Dimension UI reproduction roadmap — 2026-05-19

This is the route-by-route plan for reproducing Dimension's major UI layouts in Alfred after Dimension shuts down.

Scope: reproduce the visible product layout, spacing, materials, interaction structure, and responsive behavior. Icons do **not** need to be exact; they can be swapped later.

Use this document with:

- [`live-ui-reference-2026-05-19.md`](./live-ui-reference-2026-05-19.md)
- [`dimension-design-reference-2026-05-18.md`](./dimension-design-reference-2026-05-18.md)
- [`home-fidelity-gaps-2026-05-18.md`](./home-fidelity-gaps-2026-05-18.md)
- [`radix-route-blueprints-2026-05-19.md`](./radix-route-blueprints-2026-05-19.md)
- [`chat-tool-rendering-sycamore-2026-05-19.md`](./chat-tool-rendering-sycamore-2026-05-19.md)
- [`integrations-overall-design-2026-05-19.md`](./integrations-overall-design-2026-05-19.md)
- [`weather-and-route-notes-2026-05-19.md`](./weather-and-route-notes-2026-05-19.md)
- [`REWRITE_PROGRESS.md`](./REWRITE_PROGRESS.md)

## Browser-captured frontend assets

Dimension does not expose usable source maps. The browser still exposes enough to reproduce the UI:

| Artifact | Use |
| --- | --- |
| Minified Next route chunks | Confirm strings, asset maps, route-specific component structure, procedure names. Do not copy wholesale. |
| CSS bundles | Confirm Tailwind utility recipes, masks, radii, shadows, typography, and interaction state classes. |
| DOM snapshots | Confirm landmarks, labels, row order, dialog content, and keyboard affordances. |
| Computed styles | Confirm exact dimensions, colors, opacity, spacing, radii, and shadows. |
| Screenshots | Visual acceptance baselines. |
| Runtime assets | Weather/background media and image URLs. Use as implementation signals; commit only owned/recreated assets. |

Confirmed extracted signals:

- Weather/backgrounds use video, not CSS:
  - `sunny -> /videos/sunny.mp4`
  - `partly_cloudy -> /videos/partly_cloudy.mp4`
  - `cloudy -> /videos/cloudy.mp4`
  - `rain -> /videos/rainy.mp4`
  - `thunder -> /videos/thunderstorm.mp4`
- `/chat` renders `partly_cloudy.mp4` twice: right rail and bottom upgrade banner.
- Composer editor is TipTap/ProseMirror, with `.tiptap-minimum-input`.
- Composer mask uses a Tailwind utility equivalent to:
  `linear-gradient(180deg, transparent 0, rgba(0,0,0,.9) 12px, black calc(100% - 12px), rgba(0,0,0,.9) calc(100% - 10px), transparent)`.
- Connected-tools row is an attached bottom tray: `656 x 46`, `rounded-b-2xl`, `-mt-1`, `px-4`, `pt-3.5`, `pb-3`.
- Major interaction primitives map cleanly to Radix Dialog, Popover, Dropdown Menu, Select/Popover, Checkbox, Accordion, and Tabs.

## Implementation status

Legend:

- **Done** — implemented locally and checked.
- **Close** — major shape exists; needs focused parity tuning.
- **Stub** — route exists but still uses Alfred placeholder semantics or incomplete states.
- **Missing** — no comparable screen or state yet.

| Surface | Alfred route/component | Reference evidence | Status | Remaining layout work |
| --- | --- | --- | --- | --- |
| App shell / desktop sidebar | `apps/web/src/lib/app-shell.tsx` | `46-live-chat-home`, `live-chat-home` snapshot | Close | Sidebar row geometry still Alfred-ish: profile block, referral banner omitted, shortcut glyphs differ. Decide whether referral-like placeholder is product-true; otherwise keep omitted. |
| Home new-chat surface | `apps/web/src/routes/index.tsx` | `46-live-chat-home`, `home-fidelity-gaps` | Close | Add owned `/videos/partly_cloudy.mp4`; tune vertical offsets against 1728x936 reference; make composer and connect tray one component. |
| Weather/right rail | `QuickAccessRail`, `WeatherVideoSurface` | `46-live-chat-home`, `weather-and-route-notes` | Close | Add owned weather videos; implement full tabs with real todo/email/meeting data states; tune lower dark falloff after real video lands. |
| Home composer | `Composer` in `routes/index.tsx` | `46-live-chat-home`, CSS bundle mask | Close | Extract shared `HomeComposer`/`ComposerShell`; add real `+` popover; add model picker popover; tune mask to exact Dimension utility. |
| Connect Your Tools row | `ConnectedToolsRow` | `46-live-chat-home`, route chunk string | Close | Keep as attached tray; add provider-count variants and empty/connected states; avoid badges in home row. |
| Search palette | `CommandPalette` | `11-search-palette`, `search-palette.txt` | Done | Optional: add exact footer labels and selected-row icon treatment. |
| Chat thread completed run | `DimensionChatThread` | `09-chat-thread`, `20-chat-completed-expanded`, `20b-chat-all-expanded`, `chat-tool-rendering-sycamore` | Close | Wire real run data later; keep static preview. Add all-expanded state, title kebab, composer kebab/menu, model picker state. |
| Chat streaming run | `DimensionChatThread` extension | `30-chat-streaming-thinking-early`, `30b-chat-streaming-tool-active` | Missing | Add streaming/active tool skeleton state: animated thought row, active tool row, partial assistant text. |
| Chat artifact panel | `ArtifactPanel`, `ArtifactPageFrame` | `13-chat-artifact-pages-populated`, artifact HTML | Close | Add artifact toolbar states, page thumbnails/index, loading/PDF-generation state. iframe pages are wired from captured HTML. |
| Chat rich text/code/tables | Future message components | `21-chat-code-tables-headings` | Missing | Add markdown/code/table render recipes inside chat assistant prose. |
| Chat model picker | Future popover | `24-chat-model-picker` | Missing | Add Radix Popover with Alfred/Alfred Pro rows; selected check; exact 280px frosted material. |
| Composer mention menu | Home composer | `37`, `38`, `39` mention screenshots/snapshots | Close | TipTap typing works; popover still custom. Replace with shared Radix Popover surface and exact rows. |
| Auto-off / approval variants | Home composer + skill review | `44-auto-off-composer`, `45-auto-off-skill-review-no-gate` | Stub | Add explicit auto-off visual state and no-gate approval card variant. |
| Connect tools modal | New shared modal | `33-connect-tools-modal` | Missing | Build Radix Dialog with provider grid and connection status rows. |
| Gmail draft action/review | Future workflow/action surface | `40-gmail-action-no-approval`, `41-gmail-draft-review-response` | Missing | Add action-review cards, draft preview surface, approve/reject button row. |
| Follow-up suggestion states | Right rail/action surface | `42`, `43` tab follow-up screenshots | Stub | Build quick-rail suggestion detail and accepted state. |
| Integrations list | `/integrations` | `05-integrations`, `36-final-pass-integrations-connected`, `integrations-overall-design` | Close | Tune grouped sections and connected rows against final connected screenshot; add custom integrations section states. |
| Integration detail | `/integrations/$provider` | `06-integration-gmail-detail`, `18-integration-slack`, `integration-google-drive-detail` | Stub/Close | Gmail/Drive detail needs exact header, capability rows, related-provider rows, connected/unconnected variants. Slack coming-soon layout needs final polish. |
| Workflows list | `/workflows` | `01-workflows` | Close | Add tabs/history/approvals entry points and share affordance preview. |
| Workflow detail | `/workflows/$workflow` | `02-workflow-detail`, `02b-workflow-triggers-tab`, `17`, `17b`, `16-share-dialog` | Stub | Build detail shell with tabs: Overview, Triggers, History, Approvals; add share dialog. |
| Skills list | `/skills` | `03-skills` | Close | Tune row density and create button placement. |
| Skill detail | `/skills/$slug` | `04-skill-detail` | Close | Add exact history/learn empty states; tune top metadata and status pills. |
| Library empty/populated | `/library` | `07-library-empty`, `15-library-populated`, `07b-library-types-menu` | Close | Add populated artifact grid and types dropdown menu; keep empty state. |
| Library artifact viewer | `/library/$artifact` | `15b-library-artifact-viewer` | Close | iframe pages wired; tune header/sidebar/page controls. |
| Settings | `/settings` | `08`, `08b`, `08c`, mobile settings | Close | Add features/preferences exact tab shapes; tune inner-nav dimensions; mobile state. |
| Notes / Memory | `/notes`, `/memory` | No direct Dimension analog | Done enough | Keep Alfred-specific but within Dimension grammar. |
| Onboarding | Missing route | `25`, `25c`, `25e`, `25f`, `25h`, `25i`, `26`, `27` | Missing | Add onboarding route/dialog sequence only if product still needs it. |
| Marketing home tabs | Not current app shell | `14`, `14b`–`14g`, marketing images | Missing/Optional | Use only if Alfred needs a public marketing/home page. Not needed for authenticated product shell. |
| Mobile shells | App shell responsive | `19`, `19b`, `19c`, `19d` | Stub | Audit mobile nav, chat thread, integrations, settings. Need viewport screenshots at 390x844 and 430x932. |

## P0: finish the core product shell

These are the "must have before Dimension disappears from memory" items.

1. **Commit an owned weather video asset**
   - Add `apps/web/public/videos/partly_cloudy.mp4`.
   - Keep `WeatherVideoSurface` fallback.
   - Validate right rail and setup banner both use video, object-cover, rounded clipping, and muted autoplay loop.

2. **Extract the composer shell**
   - Create shared components:
     - `ComposerShell`
     - `ComposerEditor`
     - `ComposerToolbar`
     - `ConnectedToolsTray`
   - Use it in home and chat thread composers.
   - Keep TipTap/ProseMirror as the editor surface.

3. **Add Radix popovers/menus**
   - Add `@radix-ui/react-popover`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-checkbox`, and optionally `@radix-ui/react-tooltip`.
   - Build shared frosted wrappers:
     - `FrostPopover`
     - `FrostMenu`
     - `Checkbox`
   - Consumers:
     - composer `+` menu
     - mention menu shell
     - model picker
     - chat title kebab
     - composer kebab
     - library type menu
     - workflow share/options menus

4. **Build missing chat states**
   - Streaming/thinking.
   - Active tool row.
   - Expanded all tool accordions.
   - Markdown/code/table assistant content.
   - Model picker and kebab screenshots.

5. **Integration detail parity**
   - Gmail, Google Drive, Slack detail screens.
   - Related Google provider rows.
   - Connected/unconnected/coming soon states.
   - Connect tools modal.

## P1: complete route-specific screens

1. **Workflow detail shell**
   - Overview/detail tab.
   - Triggers tab.
   - History tab.
   - Approvals tab.
   - Share dialog.

2. **Library populated states**
   - Populated card grid.
   - Type dropdown.
   - Artifact viewer toolbar and page controls.
   - Artifact generation/loading state.

3. **Settings mobile and feature tabs**
   - User/features/preferences from screenshots.
   - Mobile settings layout.

4. **Quick rail sub-states**
   - Emails tab.
   - Meetings tab.
   - Follow-up suggestion accepted state.
   - Morning briefing entry point.

## P2: optional/product-dependent screens

1. **Onboarding**
   - Step 1 feature tabs.
   - Step 2 connect tools.
   - Step 3 done screen.

2. **Marketing/home tabs**
   - Catch up.
   - Action plan.
   - Deep work.
   - Inbox.
   - Meeting prep.
   - Daily recap.

3. **Referral banner**
   - Dimension has it; Alfred may not need it.
   - Do not add unless there is an Alfred product equivalent.

## Acceptance protocol

Every major surface should have:

1. Reference screenshot path in this file or companion docs.
2. Local screenshot at the same viewport.
3. DOM snapshot for labels/roles.
4. Computed-style spot checks for the top 5 visual anchors.
5. Keyboard checks for interactive primitives.
6. Mobile screenshot for routes with mobile references.

Default desktop viewport: `1728 x 936`, DPR 2 if possible.

Mobile viewports:

- `390 x 844`
- `430 x 932`

For each screen, verify:

- No text overlap.
- No nested cards inside cards.
- Page sections are full-width or unframed; cards are only repeated items/modals/tools.
- Icon-only controls have labels/tooltips.
- Controls keep stable dimensions on hover/focus/loading.
- Composer text and buttons do not reflow at 688px, 656px, and mobile widths.

## Capture checklist before shutdown

If Dimension is still reachable, capture these last items:

1. Network/video assets:
   - `/videos/partly_cloudy.mp4`
   - `/videos/sunny.mp4`
   - `/videos/cloudy.mp4`
   - `/videos/rainy.mp4`
   - `/videos/thunderstorm.mp4`
2. CSS snippets around:
   - `.tiptap-minimum-input`
   - `frost-border`
   - rail tabs
   - model picker
   - connected-tools row
3. DOM snapshots for:
   - model picker open
   - `+` composer menu open
   - chat title kebab open
   - library type menu open
   - workflow share dialog open
4. Mobile screenshots for:
   - chat new
   - chat thread
   - integrations
   - settings

## Implementation guardrails

- Do not clone or vendor Dimension's minified source as application code.
- Use browser artifacts to extract behavior, layout, and styling signals.
- Commit only owned or recreated media/assets.
- Keep Alfred-specific product truth: if Dimension has billing/referral/cancelation copy that Alfred does not, reproduce the layout shape with Alfred copy rather than copying the product semantics.
- Prefer Radix for focus-managed controls and TipTap for rich composer behavior.
- Keep route rewrites incremental and commit each screen/state separately.
