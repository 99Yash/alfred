# Alfred frosted-surface map — 2026-05-18

Purpose: keep Alfred's Dimension-inspired material language consistent. The immediate bug was the `@` mention menu reading as transparent over a dark background. The broader fix is not "make every card glass." Dimension uses glass selectively, mostly where a surface floats, previews generated output, or sits on top of a rich visual backdrop.

## Material taxonomy

| Material | Use For | Do Not Use For | Notes |
| --- | --- | --- | --- |
| **Frost popover** | Floating menus, comboboxes, model pickers, command palette, small contextual menus | Full page cards, normal list rows | Needs enough opacity to separate from Alfred's near-black shell. The glass should look like a material, not a transparent rectangle. |
| **Frost panel** | Tool details, approval/review handoffs, artifact citations, code blocks, tables, related suggestion badges | CRUD forms, static settings lists | Dimension's chat uses this for inspectable/generated things. It signals "this came from or controls an agent run." |
| **Inset black composer** | Main chat composer, thread composer, compact control row | Route forms like Skills/Notes unless intentionally chat-like | The composer is mostly solid black with inset highlights; it should not become a translucent card. |
| **Media-backed panel** | Right quick rail, setup/proactive prompt banner, future daily briefing hero-like surfaces | Main workspace pages | Dimension's right rail uses weather video. Alfred can use owned media/gradients, but the panel must feel alive and not like an admin sidebar. |
| **Plain work card** | Integrations list, workflow list, skills list, notes, memory facts, settings forms | Floating overlays and generated artifacts | This is important. If everything is frosted, nothing feels special and the product becomes visually noisy. |

## Side-by-side surface matrix

| Alfred Surface | Dimension Analog | Alfred Current State | Gap / Risk | Target Treatment | Priority |
| --- | --- | --- | --- | --- | --- |
| Home composer `@` mention combobox | Composer `@` mention menu: `19rem`, `rounded-2xl`, `frost-border`, `bg-gray-25/75`, `backdrop-blur`, 44px rows, 28px icon tiles | Updated to `.mention-menu-surface` with opaque gradient, blur/saturate, inner highlight, selected-row material, and icon tile material | Done for immediate bug. It should become a reusable popover material, not a one-off class forever | Rename/generalize to `.frost-popover`, keep `.mention-menu-row`, reuse for model picker, plus menu, command palette | **P0 done / P1 generalize** |
| Composer `+` action menu | Minimal two-item popover: `Add photos & files`, `Mention`; same floating menu family | Alfred's `+` currently opens mentions directly, no separate menu | If file attach lands later, it will likely reintroduce a weak transparent popover unless we reuse the frost material | Use the same `.frost-popover`; rows should be 40-44px, icon tiles 28px, no explanatory footer | **P1** |
| Model picker dropdown | Dimension model picker: compact semantic tiers, no provider names, dark gradient popover | Alfred has a disabled model chip only | When enabled, this is another likely place for a translucent/default dropdown | Use `.frost-popover`; two rows: `Alfred` and `Alfred Pro`; row descriptions allowed but muted | **P2** |
| Command palette / Search | Dimension Search row opens command/search surface; likely a floating overlay/modal | Alfred Search is a placeholder button | Search is a high-frequency overlay, so weak default modal material would be very noticeable | Full overlay dim + centered `.frost-popover` / `.frost-panel` hybrid; strong backdrop separation | **P1** |
| Connect Your Tools row | Dimension attached row below composer with provider chips | Alfred row exists and is attached to composer | Current row is acceptable, but provider chips are very small and the row uses simple transparency | Keep attached row, but use subtle frost-border chips and stronger top divider. Avoid making it a separate card | **P1** |
| Connect Tools modal | Dimension modal from landing row reuses integration catalog | Alfred currently routes to `/integrations`; no modal yet | Missing modal means route change breaks the Dimension-like "connect without leaving chat" pattern | Modal overlay: black 70% backdrop + blur; panel uses frosted modal material; catalog rows can stay plain inside | **P1** |
| Quick access rail | Dimension right rail: weather video, translucent tab group, white text, todo/email/meeting modes | Alfred has gradient-backed rail with tab modes and translucent controls | Good direction, but still static; controls can drift because each is styled ad hoc | Keep media-backed panel. Make tab group, add-todo input, empty-state icon tile use a shared `media-control`/frost control style | **P1** |
| Setup/proactive nudge banner | Dimension upgrade card uses weather video crop + bright pill CTA | Alfred has gradient banner below composer | Good structural analog, but no real media/owned visual yet | Keep as media-backed banner. Later replace gradient with owned visual loop/still; CTA stays bright white pill | **P2** |
| Run review preview | Alfred-specific safety layer; Dimension does not have this explicit gate | Current preview uses `bg-card/80`, `bg-background/55`, regular borders | It reads like another ordinary card, but it represents an agent decision boundary | Use `frost-panel` for the review shell and action list; keep user prompt as compact right-aligned bubble | **P0/P1** |
| Future chat tool accordions | Dimension tool cards: search pre-expanded, action collapsed, frosted/structured bodies | Not yet implemented as a full chat thread surface | High risk: if built with generic cards, the main Dimension chat quality is lost | Define `frost-panel` before chat thread work; use it for search result containers and action bodies | **P0 for chat** |
| Future code blocks and tables | Dimension code/table blocks use `frost-border`, dark fill, blur, multi-layer shadow | Not in the home route yet; ReactMarkdown exists elsewhere | Generic prose code/table styling will feel off immediately | Add markdown renderers with `frost-panel` shell, green inline code, copy button | **P0 for chat** |
| Future artifact citation cards | Dimension inline artifact card: frosted rounded container, icon tile, kebab, `Viewing` pill | Library placeholder exists; no produced artifacts yet | Artifact UI needs to feel first-class, not like a file attachment | `frost-panel` for citation card; right rail artifact viewer uses page renderer, not chat bubble | **P1/P0 when artifacts land** |
| Related suggestions | Dimension uses divided rows plus frosted number badges | Not implemented yet | Generic chips would miss the "actionable next step" affordance | Plain divided list, frosted 20px number badge, optional keyboard shortcuts | **P1** |
| Sidebar agent-surfaces banner | Dimension has referral/banner and recent threads; not a direct one-to-one | Alfred has a small `Agent surfaces` card in sidebar | It is currently okay, but it can look like an extra card inside nav | Either make it a restrained frost-banner or remove once recent threads exist. Do not overdecorate nav | **P2** |
| Integrations / Workflows / Skills / Library route cards | Dimension list/card pages use practical rows; not every route card is glass | Alfred uses shared `Card`, `EmptyState`, plain rows | This is mostly correct. Glass here would make routine management pages noisy | Keep plain work cards. Use frost only for modals, generated previews, or special run outputs inside these pages | **Keep plain** |
| Notes / Memory pages | Alfred-specific CRUD/data surfaces | Plain `Card` rows and `EmptyState` | Correct for repeated data. Frost would reduce scan density | Keep plain. Use frost only for future "proposed by Alfred" review panels | **Keep plain** |
| Login card | Dimension auth/onboarding has modal-like glass in places, but not central to app shell | Alfred login is a plain card | Low priority; users rarely live here | Optional later: apply modal overlay/panel treatment, but avoid spending Dimension-clone time here | **P3** |
| Mobile drawer | Dimension mobile uses hamburger + overlay nav | Alfred mobile drawer is plain card/scrim | Fine, but the drawer can borrow stronger blur and shadow once mobile polish starts | Frosted overlay/backdrop, but keep nav rows plain for readability | **P3** |

## Implementation checklist

1. **Generalize the current fix.** Move `.mention-menu-surface` toward a neutral `.frost-popover` class. Keep mention-specific row classes only where row height/selection differs.
2. **Add `.frost-panel`.** Use it for agent-produced or agent-mediated content: review previews, tool cards, code blocks, tables, artifact citations, related badges.
3. **Do not replace `Card`.** The existing `Card` primitive should remain the plain work-card default for Integrations, Workflows, Skills, Memory, Notes, and Library lists.
4. **Separate media surfaces from glass surfaces.** The right rail and setup banner are media-backed panels. Their inner controls can be frosted, but the panel itself should feel like a live widget, not a modal.
5. **Verify on real backgrounds.** Every new overlay must be checked above the home composer and above route pages. A surface that looks good on one black background can vanish on another.

## Recommended next code pass

| Step | Change | Files |
| --- | --- | --- |
| 1 | Create reusable `.frost-popover`, `.frost-panel`, `.frost-icon-tile`, and `.frost-badge` utilities | `apps/web/src/index.css` |
| 2 | Repoint mention menu from `.mention-menu-surface` to `.frost-popover` + keep row selection classes | `apps/web/src/routes/index.tsx` |
| 3 | Restyle `RunReviewPreview` shell/action list with `.frost-panel` | `apps/web/src/routes/index.tsx` |
| 4 | Tighten `ConnectedToolsRow` provider chips with `.frost-icon-tile` | `apps/web/src/routes/index.tsx` |
| 5 | Use the same classes for future command palette/model picker/plus menu, instead of inventing new transparent panels | future chat/search components |

## Design rule of thumb

If the surface is **floating**, **agent-generated**, **inspectable**, or **interrupting the current flow**, it gets frost.

If the surface is **a normal list, form, settings row, or database record**, it stays plain.
