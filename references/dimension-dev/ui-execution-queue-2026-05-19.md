# Dimension UI execution queue — 2026-05-19

This is the working queue for reproducing Dimension's authenticated product UI in Alfred with high fidelity. It turns the roadmap into actionable slices.

Goal: replicate layout, spacing, material, interaction structure, route states, and responsive behavior across the product. Icons can be approximate and replaced later.

## Operating model

Use small route/state commits. Each commit should improve one visible surface and leave the route usable.

For every slice:

1. Check the matching reference screenshot/snapshot doc.
2. Implement the static/local-state UI first.
3. Verify desktop at `1728 x 936`.
4. Verify mobile when the route has a Dimension mobile reference.
5. Record remaining gaps in `REWRITE_PROGRESS.md` or the route doc.

## Can do now

These do not need new backend APIs. They either use existing data, route-local fixture data, or component-local state.

| Order | Surface | Files | Why now | Done when |
| --- | --- | --- | --- | --- |
| 1 | Shared composer shell | `apps/web/src/routes/index.tsx`, `apps/web/src/components/dimension-chat-thread.tsx`, new `apps/web/src/components/composer-shell.tsx` | Home and chat already duplicate the same Dimension composer grammar. Extracting it reduces drift before more menus/states are added. | Home and chat use the same shell/editor/toolbar geometry; connected tools tray remains attached on home only. |
| 2 | Composer/model/context menus | Composer files plus UI menu wrappers | Pure local-state UI. High visual impact. Needed for `+`, model picker, kebab, mention shell, and library type menu. | `+` menu, model picker, and composer kebab render Dimension-style frosted panels with keyboard-safe behavior. |
| 3 | Chat state variants | `apps/web/src/components/dimension-chat-thread.tsx` | Static preview route is already isolated. Add missing Dimension states without runtime dependency. | Completed, all-expanded, streaming-thinking, active-tool, and rich-text/code/table variants can be viewed locally. |
| 4 | Artifact panel controls | `dimension-chat-thread.tsx`, `artifact-page-frame.tsx` | Captured artifact pages are already wired. Toolbar/page-state work is local. | Toolbar, page index, page thumbnails/loading state, and PDF generation placeholder match the reference shape. |
| 5 | Connect tools modal | New component used from home composer/status tray | Pure Radix Dialog/local state. It closes a visible home gap. | Modal matches provider grid/list layout and supports connected/unconnected status rows. |
| 6 | Library populated/type menu | `apps/web/src/routes/library.tsx`, `library.$artifact.tsx` | Existing local artifact data exists. Type menu is local UI. | Empty, populated grid, type dropdown, and viewer toolbar match Dimension structure. |
| 7 | Workflow detail tabs/share dialog | `apps/web/src/routes/workflows.$workflow.tsx` | Existing route exists; tabs/dialog can be fixture-backed. | Overview, Triggers, History, Approvals, and Share dialog are present with Dimension layout. |
| 8 | Integration detail variants | `integrations.$provider.tsx`, `integrations.tsx` | Existing provider catalog is enough for static variants. | Gmail, Drive, Slack, connected/unconnected/coming-soon, related Google rows, and connect CTA states match reference layout. |
| 9 | Settings feature/preferences/mobile | `apps/web/src/routes/settings.tsx` | Mostly layout tuning and local state. | User, features/preferences/notification/danger panels and mobile settings match the captured routes. |
| 10 | Quick rail sub-states | `quick-access-rail.tsx` | Local fixture states can cover tabs while real data catches up later. | Weather, emails, meetings, todo, and follow-up suggestion states all exist. |

## Needs asset or browser capture

These are blocked or risky until we capture/own the missing artifacts.

| Surface | Blocker | Recommended action |
| --- | --- | --- |
| Weather video parity | Need owned/recreated `partly_cloudy.mp4`, ideally full five-state weather set. | Use the current video hook; add owned media once available. Do not commit Dimension-hosted videos. |
| Exact mobile parity | Need route-by-route local screenshots against the captured mobile references. | After each desktop route pass, run mobile checks at `390 x 844` and `430 x 932`. |
| Exact model/context/kebab menu dimensions | Some open-menu DOM snapshots are still higher value than screenshots alone. | Capture final Dimension menu snapshots if the site remains reachable; otherwise use screenshots and CSS bundle signals. |
| Weather lower falloff tuning | True appearance depends on the owned video. | Keep current CSS fallback; retune only after the actual video asset lands. |

## Defer

These are product-dependent or not part of the authenticated core shell.

| Surface | Why defer | Revisit when |
| --- | --- | --- |
| Public marketing tabs | Alfred's authenticated shell is the priority. | If Alfred needs a public site or acquisition page. |
| Referral banner | Dimension-specific product mechanic. | Only if Alfred has a real referral or invite equivalent. |
| Full onboarding sequence | Useful, but not necessary for current authenticated route parity. | After core home/chat/integrations/workflows/settings are stable. |
| Real run wiring | User explicitly scoped this PR to UI. | m13 runtime/event work lands. |
| Real tool/API data for quick rail | Layout can be fixture-backed now. | Integrations and runtime data contracts stabilize. |

## Recommended commit sequence

1. `Extract shared Dimension composer shell`
2. `Add Dimension composer menus`
3. `Add chat preview state variants`
4. `Polish artifact panel controls`
5. `Add connect tools modal`
6. `Polish library populated states`
7. `Polish workflow detail states`
8. `Polish integration detail variants`
9. `Polish settings responsive states`
10. `Add quick rail fixture states`

## Accuracy checklist

For each route, track these anchors:

- Outer shell width, sidebar width, and main content alignment.
- Header heights and top offsets.
- Composer width, radius, toolbar height, and attached tray geometry.
- Frost material: border opacity, background opacity, blur, shadow.
- Text sizes and line heights.
- Empty/populated/loading/error state variants.
- Open popover/dialog/menu geometry.
- Focus ring and keyboard behavior for menus/dialogs.
- Desktop screenshot at `1728 x 936`.
- Mobile screenshots when applicable.

## Immediate next slice

Start with artifact panel controls.

Reason: chat state variants now exist. The next highest-impact gap is the artifact side panel: toolbar states, page index/thumbnails, loading/PDF-generation placeholder, and tighter page controls around the already wired iframe pages.

## Completed slices

- **2026-05-19 — Shared composer shell**: Added `DimensionComposerShell`, `DimensionComposerToolbar`, `DimensionComposerIconButton`, `DimensionComposerSendButton`, and `DimensionModelChip`. Home and chat now share the same shell/button geometry while keeping route-specific behavior and home-only connected-tools tray.
- **2026-05-19 — Composer menus**: Added Radix Dropdown Menu/Popover-backed context menus, model picker, and overflow menus to the shared composer primitives. Home now has a `+` menu, local model picker, and composer options menu; chat has matching context/model/overflow surfaces with chat-specific items.
- **2026-05-19 — Chat preview states**: Added query-addressable chat states: `?state=all-expanded`, `?state=streaming`, `?state=active-tool`, and `?state=rich-content`. The chat route also accepts `?artifact=1` to force the artifact panel on any thread id. Browser verification covered all five chat states including the default completed state.
