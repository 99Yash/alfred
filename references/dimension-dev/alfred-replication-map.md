# Dimension.dev -> Alfred replication map

Captured through 2026-05-18. This is the bridge between the Dimension archive and the UI Alfred already has wired. The goal is not a clone; it is a build map for reproducing the high-leverage product feel with Alfred's current React/Tailwind primitives.

Primary source files:

- `NOTES.md` - product surfaces and route-level behavior
- `tokens.md` - computed colors, type, spacing, radii, motion
- `chat-anatomy.md` - chat/run/tool/message specifics
- `onboarding.md` - onboarding and first-chat moments
- `screenshots/32-final-pass-chat-new-2026-05-18.png` - final logged-in chat landing pass
- `screenshots/33-connect-tools-modal-2026-05-18.png` - final connect-tools modal pass
- `screenshots/34-quick-rail-emails-tab-2026-05-18.png` - quick rail email tab
- `screenshots/35-quick-rail-meetings-tab-2026-05-18.png` - quick rail meetings tab
- `screenshots/36-final-pass-integrations-connected-2026-05-18.png` - current connected integrations catalog
- `screenshots/37-composer-at-mention-menu-2026-05-18.png` - composer `@` mention menu
- `screenshots/38-composer-at-mention-filter-g-2026-05-18.png` - mention filtering after typing `@g`
- `screenshots/39-composer-at-mention-inserted-2026-05-18.png` - inserted mention chip state

## Current Alfred surface area

Alfred is already closer to Dimension than a greenfield app:

| Dimension pattern | Alfred file | Current state | Keep / change |
| --- | --- | --- | --- |
| Collapsible left app shell | `apps/web/src/lib/app-shell.tsx` | Desktop collapse + mobile drawer already exist | Keep; eventually promote Integrations / Workflows / Skills / Library to first-class nav as routes land. |
| Right rail | `apps/web/src/lib/app-shell.tsx` (`useRightRail`) | Generic right-rail slot exists | Keep. This is the exact abstraction needed for quick access now and artifact viewer later. |
| Composer landing | `apps/web/src/routes/index.tsx` | Greeting, large composer, Auto chip, model chip, mic/send controls already wired visually | Keep; swap preview submit for m13 chat submit. |
| Composer mention menu | `apps/web/src/routes/index.tsx` | `@` opens a local integration picker with filtering + keyboard selection | Keep as preview behavior; m13 should turn inserted mentions into semantic tool constraints. |
| Auto/model controls | `apps/web/src/routes/index.tsx` | AutoToggle mirrors Dimension's dark gradient; ModelPicker uses semantic tier | Keep the semantic model stance from ADR-0029. Rename `Default` to `Alfred` or `Alfred Pro` only if/when tiers exist. |
| Icon-only tool buttons | `apps/web/src/lib/ui.tsx` (`ToolButton`) | Matches the composer/tool chrome need | Keep; use for attach, mention, mic, artifact header buttons. |
| Cards / rows / empty states | `apps/web/src/lib/ui.tsx` | Small primitives exist | Keep, but add a separate `FrostPanel` for Dimension's glass surfaces instead of overloading `Card`. |
| Skills list/detail | `apps/web/src/routes/skills.tsx`, `skills.$slug.tsx` | Functional m12 skill authoring + distillation history | Reshape later toward Dimension's `Prompt` + `Memory Update` + approval layout. |
| Memory approvals | `apps/web/src/routes/memory.tsx` | Proposed/confirmed facts and learn-toasts already exist | Reuse as the backend/source for Dimension-style skill memory approvals. |
| Notes composer/list | `apps/web/src/routes/notes.tsx` | Alfred-only capture surface | Keep as a personal-app primitive; not a Dimension clone target. |
| Typography/tokens | `apps/web/src/index.css` | Open Runde + Newsreader, warm OKLCH tokens, dark scale anchored on Dimension grays | Keep Alfred's type identity. Lift Dimension layout and component behavior, not necessarily DM Sans everywhere. |

## Build order

1. **Chat surface first.** Implement asymmetric message rendering, run summary pills, tool accordions, and related chips before expanding more routes. This is the highest-value Dimension pattern and maps directly to m13.
2. **Right rail second.** Replace the placeholder rail in `HomeRightRail` with three tabs: Tasks, Emails, Meetings. The 2026-05-18 captures confirm Emails and Meetings are full-mode tabs with simple empty states, not subpanels under To Do.
3. **Command palette.** Wire the existing Search sidebar row to a modal with nav defaults (`New Chat`, `Settings`, `Integrations`, `Workflows`, `Skills`, `Library`) before full chat search exists.
4. **Integrations catalog.** Build catalog rows and connector detail pages from provider metadata. The final pass shows the same catalog appears both as `/integrations` and as the `Connect Your Tools` modal.
5. **Skills/memory convergence.** Keep the existing skill backend, but change the detail UI to show source prompt, generated memory bullets, approvals, and run history in Dimension's two-tab shape.
6. **Workflows.** Build as `prompt + trigger`; do not introduce a graph editor. Add `History` and `Approvals` tabs as URL-state tabs.
7. **Artifacts/library.** Defer until Alfred has artifact-producing tools. When it lands, reuse the right-rail slot for in-chat artifacts and build Library as a unified artifact gallery.

## Component recipes to add

These are deliberately small and compatible with the current `ui.tsx` style.

| Component | Purpose | Built from | Dimension source |
| --- | --- | --- | --- |
| `FrostPanel` | Signature glass wrapper for code blocks, tables, artifact cards, related number badges | `rounded-2xl`, `bg-card/70`, `backdrop-blur-sm`, `border`, layered shadow | `chat-anatomy.md`, `tokens.md` |
| `ChatColumn` | Scroll region with centered `max-w-5xl` thread content | `div` wrapper only | `chat-anatomy.md` |
| `UserMessageBubble` | Right-aligned user prompt bubble | `rounded-2xl bg-card/75 px-4 py-3 ml-auto max-w-2xl` | `chat-anatomy.md` |
| `AssistantProse` | Full-width markdown response, no bubble | `ReactMarkdown`, `remark-gfm`, Tailwind Typography | `skills.$slug.tsx` already uses this stack |
| `RunSummaryButton` | Collapsed "Searched multiple sources..." run heading | `button`, chevron, optional count/status text | `chat-anatomy.md` |
| `ThoughtPill` | Muted CoT summary disclosure | `button`, chevron, muted markdown body | `chat-anatomy.md` |
| `ToolAccordion` | Search/action tool details | generic accordion wrapper; tool-specific body slots | `chat-anatomy.md` |
| `SearchResultList` | Pre-expanded search results with favicons | rows using `google.com/s2/favicons` | `chat-anatomy.md` |
| `RelatedSuggestions` | Numbered follow-up rows | divided list + `FrostPanel` number badge | `chat-anatomy.md` |
| `MentionMenu` | `@` integration picker in composer | text trigger, filtered list, arrow/Enter/Tab keyboard loop | screenshots 37, 38, 39 |
| `QuickAccessRail` | Tasks / Emails / Meetings tabs | `useRightRail` + local tab state | final-pass screenshots 32, 34, 35 |
| `IntegrationCatalog` | Search + grouped provider rows | provider metadata array | screenshots 33, 36 |
| `ConnectorDetail` | Trust banner + capabilities + accounts table | provider metadata + credentials data | `NOTES.md`, screenshots 06, 18 |
| `ArtifactPanel` | Right-rail document/page stream | `useRightRail`, iframe-per-page renderer later | `NOTES.md`, artifact screenshots |

Avoid forcing all card-like surfaces through `Card`. Dimension has two visual categories:

- **Plain work cards**: lists, forms, rows. Use existing `Card`, `CardRow`, `EmptyState`.
- **Generated/inspectable artifacts**: code blocks, tables, artifact citation cards, related badges. Use `FrostPanel`.

## Surface mapping

### App shell

Dimension's primary nav is `New Chat`, `Search`, `Integrations`, `Workflows`, `Skills`, `Library`, settings pinned at the bottom. Alfred currently has `Skills`, `Memory`, `Notes`, and disabled "soon" rows for `Workflows`, `Integrations`, `Library`.

Recommended Alfred shape:

- Keep `New chat` as the top CTA.
- Search opens command palette, not a route.
- Promote `Integrations`, `Workflows`, `Skills`, `Library` when each route exists.
- Keep `Memory` and `Notes` in a secondary group because they are Alfred-specific primitives, not Dimension's four pillars.
- Keep theme/sign-out in the footer.

### Home / chat landing

Current `HomePage` already has the right skeleton. Changes when m13 chat lands:

- Composer submit creates or resumes a chat run instead of logging to console.
- Replace bottom helper text with connected-tool affordances or remove it once the composer is live.
- Right rail becomes `QuickAccessRail`.
- Add first-prompt suggestion from cold-start research when available, matching `onboarding.md`'s "hidden 4th surface."
- Keep `@` mention support in the composer. Today Alfred inserts plain-text mentions; m13 should preserve selected mention IDs in the run request.

### Composer `@` mentions

Dimension uses a ProseMirror/Tiptap composer. Typing `@` opens a floating mention list above the editor. Pressing ArrowDown/ArrowUp moves the active row, Enter inserts the selected item, and typing after `@` filters the list.

Captured mechanics:

- Editor root class: `tiptap ProseMirror tiptap-minimum-input w-full p-2 focus-visible:outline-none text-sm max-h-[320px] overflow-auto min-h-[50px]`.
- Popup wrapper: `react-renderer` positioned absolute with `z-index: 50`, `data-side="bottom-start"`, `animate-in fade-in-0 zoom-in-95`, and directional slide classes.
- Popup surface: `min-w-[19rem] max-w-[19rem] rounded-2xl frost-border bg-gray-25/75 backdrop-blur`, `p-2`, max height `20rem`, scrollable.
- Item row: `h=44px`, full width, `rounded-[10px] px-2 py-2`, `gap-2.5`, `text-sm`, selected state `aria-selected:bg-gray-200/45` which resolves to `rgba(40,40,40,0.45)` in dark mode.
- Icon tile: 28px square (`size-7`) with the same frost-border treatment and provider SVG inside.
- Empty query list observed: `Collaborators`, `Linear`, `Notion`, `Google Drive`, `Google Docs`, `Google Sheets`, `Google Slides`, `Google Calendar`, `Gmail`, `Web`, `Slack`.
- Filter query `@g` observed: `GitHub`, `Gmail`, `Google Calendar`, `Google Docs`, `Google Drive`, `Google Sheets`, `Google Slides`, `Granola`, `PostHog`, `Mercury`, `Supabase`. Filtering is fuzzy, not strict prefix matching.
- Inserted mention becomes a non-editable node with `data-id="google_gmail"` and `data-item` JSON. It renders as a small purple pill: `rounded-full bg-purple-500/10 px-1`, gradient-clipped purple label, inline `@`, and a 14px provider icon.

Alfred preview implementation:

- `apps/web/src/routes/index.tsx` now has `MentionMenu` on the home composer.
- Trigger and keyboard loop are live: `@`, filtering, ArrowUp/ArrowDown, Enter/Tab insert, Escape closes.
- It intentionally inserts plain text (`@Gmail `) because the current composer is still a textarea. The real chat composer should switch to a rich text model or maintain a parallel mention-token array so the backend gets `{ id, label, type }`, not only a string.

### Quick access rail

Final live behavior:

- Top strip: location + weather.
- Three tab modes: To Do, Emails, Meetings.
- To Do mode includes filter row, add-todo composer, Suggestions.
- Emails mode empty state: `All done!` / `No pending email drafts.`
- Meetings mode empty state: `All done!` / `You have no meetings scheduled for today.`

Alfred implementation:

- Start with empty states and health/status data removed.
- Back Tasks with action-item workflow output when available.
- Back Emails with triage / draft approval state when available.
- Back Meetings with calendar integration later.

### Chat

This is the priority lift. Alfred should copy behavior more than exact visuals:

- User prompt: compact right-aligned bubble.
- Assistant final response: no bubble, markdown prose.
- Running state: one `Working on it...` heading, then chronological thought/tool/status nodes.
- Completed state: collapse the entire tool timeline behind one summary button.
- Search/lookup tools: pre-expanded result list.
- Action tools: collapsed by default; expanded body shows the produced object, not a textual summary.
- Inline statuses mutate in place from in-progress to resolved text.
- Assistant-only reactions: copy, thumbs up, thumbs down.
- Related suggestions: 1-4 full-width numbered rows.

Existing local support:

- `ReactMarkdown` + `remark-gfm` already installed and used in `skills.$slug.tsx`.
- `lucide-react` already installed.
- `ToolButton` already supports composer icon controls.

Missing local support:

- Accordion primitive. Use a tiny local component or Radix if added deliberately; do not need full shadcn import for the first pass.
- Code block renderer with copy button.
- Run event shape from m13 needs to preserve `streaming`, `resolved`, and `collapsed summary` states.

### Integrations

Dimension has one provider metadata schema in two surfaces:

- `/integrations` page
- `Connect Your Tools` modal from the chat landing

The final pass added current connected providers that earlier screenshots did not show: Google Drive, Google Calendar, Gmail, Notion, GitHub, Vercel, Railway. The modal also includes `Your Integrations -> MCP Server -> Add Integration`.

Alfred should define provider metadata once:

```ts
type IntegrationProvider = {
  id: string;
  name: string;
  category: "connected" | "apps" | "productivity" | "business" | "development" | "custom";
  description: string;
  capabilities: string[];
  status: "connected" | "available" | "coming_soon";
  detail?: {
    trustTitle: string;
    trustBody: string;
    overview: string;
  };
};
```

Then render catalog page, connect-tools modal, and connector detail from the same data.

### Skills and memory

Dimension's skill UI is a productized memory approval surface. Alfred currently splits this across `skills` and `memory`.

Recommended merge:

- Skill list stays a card/list page.
- Skill detail `Learn` tab becomes:
  - original prompt / latest prompt
  - generated memory update bullets
  - approve/reject controls
  - current skill body as secondary content
- `History` tab keeps run list.
- `Memory` route remains the global fact database, but skill-specific fact approvals should be visible in skill detail.

### Workflows

Dimension's workflow builder is a schedule/trigger header plus a prompt textarea. Alfred's ADR-0027 already matches this.

Implementation guardrails:

- Use URL-state tabs for `plan`, `history`, `approvals`.
- Keep `Auto approve` per workflow.
- Schedule UI should read as natural language: `From <date> run every <n> <unit> at <time>`.
- Prompt textarea should support `@` mentions once integration mentions exist.

### Library / artifacts

Do not build this until artifacts exist. When it does:

- In-chat artifact viewer should borrow the right rail.
- Library cards should use real rendered content previews, not generic file icons.
- Standalone viewer should be modal/focused, with `Esc to exit`.

## Visual implementation notes

- **Do not replace Alfred's type system wholesale.** Dimension uses DM Sans; Alfred currently uses Open Runde with Newsreader accents. The app already feels personal. Keep it unless a future pass intentionally standardizes on DM Sans.
- **Use Dimension's spacing discipline.** Default gap is 8px; 4px for tight icon/text clusters; 12/16/24px for section separation.
- **Keep radii familiar.** Dimension uses 4/8/12/16/24/9999. Alfred's Tailwind radii can already express this.
- **Use Lucide for chrome.** Dimension used Lucide for structural icons; Alfred already depends on `lucide-react`.
- **Keep model names opaque.** Dimension exposes semantic tiers only. Alfred ADR-0029 already says the same.
- **Avoid card nesting.** Page sections should stay unframed; use cards only for repeated rows/forms/modals.
- **Use progressive disclosure sparingly.** Tool timelines need accordions; regular settings/catalog rows do not.

## Things intentionally not copied

- Billing/upgrade and referral surfaces.
- Dimension's locked `Skill` title behavior.
- Raw provider/model names in the composer.
- Flat recent-thread list as the only organization model forever.
- Full marketing page treatment inside the authenticated app.

## Final-pass additions

The 2026-05-18 pass added these archive artifacts after the first study:

- `screenshots/32-final-pass-chat-new-2026-05-18.png`
- `snapshots/final-pass-chat-new-2026-05-18.txt`
- `screenshots/33-connect-tools-modal-2026-05-18.png`
- `snapshots/connect-tools-modal-2026-05-18.txt`
- `screenshots/34-quick-rail-emails-tab-2026-05-18.png`
- `snapshots/quick-rail-emails-tab-2026-05-18.txt`
- `screenshots/35-quick-rail-meetings-tab-2026-05-18.png`
- `snapshots/quick-rail-meetings-tab-2026-05-18.txt`
- `screenshots/36-final-pass-integrations-connected-2026-05-18.png`
- `snapshots/final-pass-integrations-connected-2026-05-18.txt`
- `screenshots/37-composer-at-mention-menu-2026-05-18.png`
- `snapshots/composer-at-mention-menu-2026-05-18.txt`
- `screenshots/38-composer-at-mention-filter-g-2026-05-18.png`
- `snapshots/composer-at-mention-filter-g-2026-05-18.txt`
- `screenshots/39-composer-at-mention-inserted-2026-05-18.png`
- `snapshots/composer-at-mention-inserted-2026-05-18.txt`

These close three practical gaps: the `Connect Your Tools` modal, the non-task quick-rail tabs, and the composer `@` mention interaction.
