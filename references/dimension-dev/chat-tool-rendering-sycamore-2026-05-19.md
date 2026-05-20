# Dimension chat tool rendering reference — Sycamore thread — 2026-05-19

Live route inspected in the authenticated Chrome session:

- URL: `https://dimension.dev/c/sycamore-labs-interview-preparation-thg2ca`
- Title: `Sycamore Labs Interview Preparation - Dimension`
- Viewport: `1728 x 992`
- Local-only screenshot for visual QA: `/private/tmp/dimension-sycamore-thread-current.png` (not committed; the thread contains personal/interview context)
- Sanitized HTML repro: [`html-repros/chat-tool-rendering-2026-05-19.html`](./html-repros/chat-tool-rendering-2026-05-19.html)

This capture is the best current reference for Dimension's completed research-run UI: grouped web-search tools, nested thought disclosures, inline source citations, per-message reaction buttons, and the active-thread composer. It also verifies that the old PDF/artifact preview is **not mounted** in this current route state.

## Current iframe / artifact status

The current Sycamore thread has:

- `iframeCount: 0`
- No `iframe`, `embed`, or `object` nodes.
- No visible PDF, artifact, preview, blob, Google Drive, or download-like links in the live DOM.
- No right-side artifact panel in the accessibility tree; the route is chat-only plus the persistent left sidebar and bottom composer.

So this page preserves the **tool trace and prose rendering**, but not the generated PDF preview. The older PDF/artifact behavior remains documented in:

- [`screenshots/13-chat-pdf-generation.png`](./screenshots/13-chat-pdf-generation.png)
- [`screenshots/13b-chat-artifact-completed.png`](./screenshots/13b-chat-artifact-completed.png)
- [`snapshots/chat-artifact-pdf.txt`](./snapshots/chat-artifact-pdf.txt)
- [`artifact-html/README.md`](./artifact-html/README.md)
- [`artifact-html/sycamore-pdf/`](./artifact-html/sycamore-pdf/)

The practical reconstruction rule is: build the chat trace independently from the artifact panel. When an artifact exists, mount a side panel with per-page `iframe srcdoc` previews and the `pdf-page-ready` `postMessage` handshake from the artifact HTML corpus. When no artifact exists, the center chat column should remain full-width inside the 1024px conversation container.

## Source-map status for this route

The live route loads Next build `2Yg6GmRb0YtGO-YJVw6mf` with deployment query `dpl_HfumqwUvw2j9zVXSutQ6y2HiZDC4`.

Relevant route chunks observed:

- `/pages/c/[slug]-594c1366fedc6a92.js` — current share/slug route, about 39KB decoded.
- `/pages/chat/[[...threadId]]-646722aa66fe6b92.js` — chat route chunk, about 255KB decoded.
- `/pages/library/[[...artifactId]]-6c3597964c40093e.js` — library/artifact chunk, preloaded after the chat page.

Same-origin Dimension chunks fetched successfully but did not expose `sourceMappingURL` comments. The only source map hint in the sampled scripts was a third-party PostHog survey script. Treat the bundle as minified evidence only: useful for class strings and asset names, not source reconstruction.

## Live structure

High-level accessible tree:

```text
region "Shutdown notice"
main
  navigation
    link "New Chat Shift O"
    button "Search K"
    link "Integrations"
    link "Workflows"
    link "Skills"
    link "Library"
    link "Refer and earn credits"
  link "Settings"
  user message
  button "Searched multiple sources" aria-expanded=true
  region "Searched multiple sources"
    button "Thought for 2s"
    text thought summary
    button "Sycamore Labs company 10 results found" aria-expanded=true
    region result rows
    button "Sycamore Labs tech stack engineering 10 results found" aria-expanded=true
    region result rows
    text "Processed www.yashk.xyz."
    button "Thought for 2s"
    text thought summary
    button "Sycamore Labs careers hiring 10 results found" aria-expanded=true
    region result rows
    image "user-search"
    text "People search completed successfully."
  button "Thought for 34s"
  assistant markdown response
  reaction buttons
  later short turns
  button "Gathered information" aria-expanded=true/false
  region result rows when expanded
  composer
region "Notifications alt+T"
alert
```

Key observation: the tool trace is a nested Radix Accordion-like hierarchy. The top-level run summary owns one content region; inside it, thought accordions and search-result accordions are chronological siblings.

## Tool trace anatomy

### Top-level run summary

Observed button:

```text
button "Searched multiple sources"
aria-expanded="true"
width: 1024px
height: 20px
font: 14px / 20px, weight 500
color: rgb(237, 237, 237)
background: transparent
class includes:
  group/accordion-trigger
  w-full
  text-left
  text-sm
  font-medium
  transition-all
  focus-visible:ring-1
```

Use Radix Accordion:

```tsx
<Accordion.Root type="multiple">
  <Accordion.Item value="run-1">
    <Accordion.Trigger>Searched multiple sources</Accordion.Trigger>
    <Accordion.Content>
      <ThoughtDisclosure />
      <SearchResultsDisclosure />
      <InlineStatus />
    </Accordion.Content>
  </Accordion.Item>
</Accordion.Root>
```

Completed summary labels are semantic, not tool names. Existing labels observed across captures:

- `Searched multiple sources`
- `Gathered information`
- `Searched multiple sources and finished multiple actions`
- `Finished one action`

### Thought disclosures

Observed buttons:

- `Thought for 2s`
- `Thought for 34s`

Styles:

- Same 14/20 font as summary pills.
- Muted text color: `rgb(112, 112, 112)`.
- Transparent background.
- No surrounding card.
- Chevron rotates on open.
- Expanded body is plain markdown/prose, also muted.

Behavior:

- The active streaming state uses `Thinking` as a heading.
- The resolved state changes into `Thought for Xs`.
- Multiple identical durations are valid; do not dedupe.

Radix target:

```tsx
<Accordion.Item value={thought.id}>
  <Accordion.Trigger className="dimension-thought-trigger">
    Thought for {thought.duration}
  </Accordion.Trigger>
  <Accordion.Content className="dimension-thought-content prose-markdown-renderer muted">
    {thought.summary}
  </Accordion.Content>
</Accordion.Item>
```

### Web-search result accordions

Observed search trigger:

```text
button "Sycamore Labs company 10 results found"
aria-expanded="true"
button rect: 672 x 20
left inset: 37px from the run-summary edge
```

Observed expanded result container:

```text
result rows: 10
row rect: 663 x 28
row class: flex items-center justify-between gap-4 rounded p-1.5 ring-inset hover:bg-white/[0.04]
row border radius: 4px
row padding: 6px
favicon: https://www.google.com/s2/favicons?domain=<host>&sz=128
```

DOM target:

```tsx
<Accordion.Item value={query.id}>
  <Accordion.Trigger className="dimension-search-trigger">
    <span className="line-clamp-1">{query.label}</span>
    <ChevronRight aria-hidden />
    <span className="ml-auto shrink-0 text-muted">{results.length} results found</span>
  </Accordion.Trigger>

  <Accordion.Content>
    <div className="dimension-search-result-list">
      {results.map((result) => (
        <a href={result.url} className="dimension-search-result-row">
          <img alt={result.title} src={faviconUrl(result.url)} />
          <span className="line-clamp-1">{result.title}</span>
          <span className="domain">{result.domain}</span>
        </a>
      ))}
    </div>
  </Accordion.Content>
</Accordion.Item>
```

Result-list visual:

- `mt-1.5`
- `rounded-lg`
- `border: 0.5px solid rgb(40, 40, 40)`
- `p: 4px`
- `max-height: 130px`
- `overflow-y: auto`
- hide scrollbar where possible

### Bare inline status rows

Observed rows:

- `Processed www.yashk.xyz.`
- `People search completed successfully.`

The people-search row includes an image/SVG with accessible name `user-search`, then a static text node. It is not a chip or card.

Build target:

```tsx
<div className="dimension-tool-status">
  <ToolIcon name="user-search" aria-hidden={false} title="user-search" />
  <span>People search completed successfully.</span>
</div>
```

Keep these as low-chrome rows. The important part is the chronological interleave with the search/thought cards.

## Assistant prose rendering

The final response uses markdown-style prose, not a bubble. In this route it includes:

- `h2` main heading.
- `h3` section headings.
- Paragraphs.
- Bold labels.
- A table-like comparison area that appears in the a11y tree as sequential text nodes rather than a semantic `table`.
- Inline source citations.

Inline citation structure:

```html
<a href="https://source.example">
  <span class="favicon-wrap">
    <img alt="Web Search" src="https://www.google.com/s2/favicons?domain=source.example&sz=128" />
  </span>
  Source label
</a>
```

The favicon is the citation indicator. There are no superscript numbers, brackets, footnotes, or citation popovers in this capture.

## Reaction row

Every assistant message gets three icon-only buttons after the prose:

- `clone`
- `thumbs-up`
- `thumbs-up` again, visually rotated for thumbs-down

Measured button style:

- `20 x 20`
- `border-radius: 6px`
- transparent background
- color `rgb(160, 160, 160)`

Accessibility issue to fix in Alfred: Dimension exposes the third button as another `thumbs-up` because it reuses the same SVG title. Alfred should keep the visual reuse but set explicit labels:

- `aria-label="Copy response"`
- `aria-label="Good response"`
- `aria-label="Bad response"`

## Active-thread composer

Visible composer state after credits are exhausted:

- Tiptap/ProseMirror editor.
- Editable region rect: `988 x 36`, x `480`, y `879`.
- Placeholder text: `Send a message to copy the conversation`.
- Toolbar:
  - menu button with `haspopup="menu"`
  - `Auto` button, `71 x 31`, `rounded 10px`
  - text `Credits have exhausted`
  - `Upgrade` link to `/settings?section=plan`
  - microphone button
  - disabled send button

Alfred can mimic the layout with a textarea today, but the DOM-equivalent target is TipTap/ProseMirror plus a Radix Popover for the menu and a clear disabled send button state.

## Keyboard and accessibility contract

Use Radix primitives to preserve behavior:

- Accordion triggers are real `<button>` elements with `aria-expanded` and `aria-controls`.
- `Enter` and `Space` toggle the selected disclosure.
- Chevron rotation is tied to `data-state="open"`.
- Expanded content is a named region associated with the trigger label.
- Search results are real links and keep their destination in `href`.
- Result list overflow must be keyboard-scrollable when focused.
- Icon-only buttons need explicit `aria-label`; do not rely on SVG `<title>`.
- The composer menu trigger needs `aria-haspopup="menu"` and a focus-restoring menu/popover.
- Disabled send should be an actual disabled button, not just opacity.
- The live notifications region should remain `aria-live="polite"`; blocking alerts should use assertive only when necessary.

## Radix primitive map

| Live Dimension surface | Alfred/Radix equivalent |
| --- | --- |
| Run summary disclosure | `Accordion.Root` + one `Accordion.Item` per assistant run |
| Thought disclosure | Nested `Accordion.Item`, muted trigger/content style |
| Search-result group | Nested `Accordion.Item`, open by default when run summary opens |
| Search-result rows | Plain anchors inside a capped scroll container |
| Status rows | Plain flex rows with custom action SVG |
| Assistant markdown | Tailwind Typography-style renderer |
| Inline web citations | Anchor with favicon image prefix |
| Reactions | Icon buttons with explicit labels |
| Composer menu | Radix Popover or Dropdown Menu |
| Composer editor | TipTap/ProseMirror later; textarea fallback is acceptable short-term |
| Artifact/PDF preview | Absent here; use separate iframe artifact panel only when an artifact exists |

## Standalone HTML repro checklist

The repro at [`html-repros/chat-tool-rendering-2026-05-19.html`](./html-repros/chat-tool-rendering-2026-05-19.html) intentionally includes:

- Top shutdown banner and left app navigation.
- Right-aligned user bubble.
- Top-level completed-run accordion.
- Nested thought accordions.
- Nested search-result accordions with favicon rows.
- Bare status row.
- Assistant prose with inline favicon citations.
- Reaction buttons with corrected labels.
- A second collapsed/expandable research-run summary.
- Bottom active-thread composer with disabled send state.
- Keyboard support for disclosure toggles: `Enter`/`Space`.
- `Escape` behavior: collapses the currently focused disclosure.
- No iframe by default, matching the current live page.

