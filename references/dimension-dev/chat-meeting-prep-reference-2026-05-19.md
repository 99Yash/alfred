# Dimension chat meeting-prep reference — 2026-05-19

Captured from the authenticated live `https://dimension.dev/chat` surface on 2026-05-19. This pass focuses on the new meeting-prep enhancement visible on the chat landing page.

This document is sanitized: meeting names, people names, account URLs, and private prep content are represented as placeholders. The original observation was made against the live page; the pushed reference should be safe to reuse as an implementation spec.

Companion files:

- Route-level blueprint: [`radix-route-blueprints-2026-05-19.md`](./radix-route-blueprints-2026-05-19.md)
- Live chat evidence bundle: [`live-ui-reference-2026-05-19.md`](./live-ui-reference-2026-05-19.md)
- Repro HTML: [`html-repros/chat-meeting-prep-2026-05-19.html`](./html-repros/chat-meeting-prep-2026-05-19.html)

## What changed

The chat landing center column now has an `UPCOMING MEETING` card below the composer and connect-tools row.

Previously this card was title + time + `Join`. The current live version includes:

1. A section label: `UPCOMING MEETING`
2. Meeting title
3. Inline time range
4. A generated one-paragraph prep summary
5. Icon-only `View meeting prep` button
6. `Join` pill link
7. A Radix-shaped `Meeting Prep` dialog containing detailed notes

This is a high-value Alfred pattern: the assistant surfaces context before the user asks, and keeps the action lightweight (`View prep` or `Join`).

## Center meeting card anatomy

DOM target:

```tsx
<section aria-labelledby="upcoming-meeting-heading" className="upcoming-meeting">
  <div className="meeting-label-row">
    <p id="upcoming-meeting-heading">UPCOMING MEETING</p>
    <Button variant="ghost" size="sm">Show all meetings</Button>
  </div>

  <div className="meeting-card-row">
    <VideoIcon aria-hidden />
    <div className="meeting-copy">
      <p>
        <span>{meeting.title}</span>
        <span aria-hidden>  •  </span>
        <time>{start}</time>
        <span aria-hidden> - </span>
        <time>{end}</time>
      </p>
      <p>{meetingPrep.summary}</p>
    </div>

    <Dialog>
      <DialogTrigger asChild>
        <IconButton aria-label="View meeting prep" tooltip="Meeting prep" />
      </DialogTrigger>
      <MeetingPrepDialog />
    </Dialog>

    <Button asChild variant="ghost" size="md">
      <a href={meeting.joinUrl}>Join</a>
    </Button>
  </div>
</section>
```

Observed styling:

| Element | Recipe |
| --- | --- |
| Section label | `text-xs font-bold uppercase`, color around `white/60`, left aligned |
| Card row | `mt-4`, `flex items-start justify-between`, `gap-2.5` |
| Left icon | Small video glyph, `size-3`, `text-white/50`, nudged down with top margin |
| Title/time line | `body-lg`, `font-medium`, `text-white/90`, title and time on one line |
| Separator | Literal bullet with whitespace: `  •  ` in `text-white/50` |
| Summary | Small text below title/time, opacity ~80%, max two to three lines |
| Action buttons | Ghost pill recipe: `bg-white/[0.05]`, hover `bg-white/[0.08]`, active `bg-white/[0.03]`, `rounded-full`, `px-3 py-1.5`, `text-sm` |
| Prep trigger | Icon-only ghost pill, observed `44 × 32`, accessible name `View meeting prep` |
| Join link | Ghost pill, observed `75 × 32`, visible text `Join` + icon |

Implementation notes:

- Keep the prep trigger and Join link in the same row, right aligned.
- The summary belongs inside the meeting card, not inside the dialog only. It creates enough value without opening the modal.
- Do not expose raw calendar attendees in the collapsed card unless needed. Detailed attendees belong in the dialog.
- If no prep exists, keep the same card but hide/disable the prep trigger and show a neutral summary like `No prep notes yet.`

## Meeting-prep dialog anatomy

Observed live DOM:

- `role="dialog"`
- `aria-labelledby` points at the `Meeting Prep` heading
- `aria-describedby` points at sr-only description text: `Meeting preparation notes.`
- Overlay: full viewport, `fixed`, `z-[100]`, `bg-gray-0/70`, `backdrop-blur-sm`
- Content: fixed centered panel on desktop, bottom sheet on mobile classes present
- Desktop panel rect at `1728 × 936` viewport: `768 × 735`, x `480`, y `101`
- Content max height: `calc(100vh - 5rem)` desktop class, `70dvh` mobile class
- Material: `rgb(27,27,27)`, `backdrop-filter: blur(8px)`, `rounded-3xl`, `frost-border`, `border: 0.5px transparent`, inset hairline shadow

DOM target:

```tsx
<DialogContent
  title="Meeting Prep"
  description="Meeting preparation notes."
  className="meeting-prep-dialog"
>
  <header>
    <DialogTitle>Meeting Prep</DialogTitle>
    <DialogDescription className="sr-only">
      Meeting preparation notes.
    </DialogDescription>
    <DialogClose asChild>
      <IconButton aria-label="Close Dialog" />
    </DialogClose>
  </header>

  <ScrollArea className="meeting-prep-scroll">
    <section>
      <h3>Where things stand:</h3>
      <p>{summary}</p>
    </section>

    <section>
      <h3>Open items to track status on:</h3>
      <ul>
        <li><strong>{topic}</strong> <span>({owner})</span>: {question}</li>
      </ul>
    </section>

    <section>
      <h3>Who's usually in the room:</h3>
      <p>{attendeeSummary}</p>
    </section>
  </ScrollArea>

  <footer>
    <IconButton aria-label="Copy meeting prep" />
  </footer>
</DialogContent>
```

Content structure:

| Section | Role |
| --- | --- |
| Header | Visible `h2` with `18px/28`, weight `500`; close button top-right |
| Description | Present for screen readers; visually hidden |
| Intro block | Short heading-like sentence plus paragraph |
| Open items | Bullet list of status checks. Each item starts with bold topic, optional owner/people context, then a question |
| Attendees | One paragraph listing recurring attendees or roles |
| Footer action | Icon-only bottom-right button; live DOM had no accessible name observed, so Alfred should add one |

## Keyboard behavior observed

Starting state:

- Focus was on the `View meeting prep` trigger in the meeting card.
- Pressing Enter/click opens the dialog.

When dialog opens:

- Focus is trapped inside the dialog.
- Live focus initially landed on an icon-only action near the bottom-right of the dialog.
- Pressing `Tab` moved to `Close Dialog`.
- Pressing `Tab` again looped back to the bottom-right icon action.
- Pressing `Escape` closed the dialog and restored focus to `View meeting prep`.

Alfred implementation requirements:

1. `View meeting prep` must be a real button with accessible name `View meeting prep`.
2. Dialog must have `DialogTitle` and `DialogDescription`.
3. Add `aria-modal="true"` through the Radix Dialog content wrapper, or verify Radix emits it in Alfred's wrapper. It was not present in the inspected live DOM.
4. Initial focus should land on the dialog content/heading or the close button. Do not focus an unlabeled icon-only footer action first.
5. Every icon-only action must have `aria-label`.
6. `Tab` and `Shift+Tab` must wrap within the dialog.
7. `Escape` must close and return focus to the trigger.
8. Background scroll must be locked while open; live `body` overflow was `hidden`.
9. The overlay should be dismissible by click only if the same action is safe as pressing Escape.
10. The Join link must stay outside the dialog and must not be auto-focused.

## Accessibility checklist

Meeting card:

- `section` has a label or labelled heading.
- Meeting time is represented with `<time datetime="...">` when real dates are available.
- Decorative icons are `aria-hidden="true"`.
- Prep summary text is visible text, not tooltip-only content.
- `View meeting prep` icon button has accessible name and visible tooltip.
- `Join` is an anchor with a clear accessible name like `Join {meeting title}` if multiple meeting cards can exist.

Dialog:

- Use Radix Dialog for focus trap, portal, Escape handling, outside interaction, and focus restoration.
- Use `DialogTitle`, `DialogDescription`, `DialogClose`.
- Use a semantic outline inside: `section` + `h3` or `dl` where appropriate.
- Use `<ul>` for open status items.
- Avoid a wall of text: split sections with spacing and dividers.
- If content overflows, the scroll container must be keyboard scrollable.
- Preserve text selection/copy for prep notes.
- Do not hide essential content behind hover-only affordances.

Screen reader behavior target:

1. Trigger announces: `View meeting prep, button, has popup dialog`.
2. On open: `Meeting Prep, dialog. Meeting preparation notes.`
3. Close button announces: `Close Dialog, button`.
4. Prep content reads in source order: overview, open items, attendees.
5. Escape returns to `View meeting prep`.

## Visual CSS recipe

Use these tokens from `dimension-design-reference-2026-05-18.md`:

```css
.meeting-prep-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
}

.meeting-prep-dialog {
  position: fixed;
  z-index: 101;
  left: 50%;
  top: 50%;
  width: min(768px, calc(100vw - 32px));
  max-height: calc(100vh - 5rem);
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  padding: 16px 22px 8px;
  border-radius: 24px;
  color: rgb(237, 237, 237);
  background: rgb(27, 27, 27);
  border: 0.5px solid transparent;
  backdrop-filter: blur(8px);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.1);
}

.meeting-prep-dialog h2 {
  font-size: 18px;
  line-height: 28px;
  font-weight: 500;
}

.meeting-prep-scroll {
  overflow: auto;
  padding-right: 6px;
}
```

Mobile target:

- Content becomes a bottom sheet.
- `left: 0`, `bottom: 0`, `width: 100%`, `max-height: 70dvh`.
- Top corners are rounded, bottom corners can be square if flush to viewport.
- Close button remains top-right.

## Reproduction steps

Use the static repro file:

1. Open [`html-repros/chat-meeting-prep-2026-05-19.html`](./html-repros/chat-meeting-prep-2026-05-19.html) in a browser.
2. Press `Tab` until `View meeting prep` is focused.
3. Press `Enter`.
4. Confirm focus moves inside the dialog and background scroll is locked.
5. Press `Tab` and `Shift+Tab`; focus must wrap between dialog controls.
6. Press `Escape`; dialog closes and focus returns to `View meeting prep`.
7. Reopen and click `Close Dialog`; focus returns to the trigger.
8. Resize below 640px width; dialog should behave as a bottom sheet.

Expected differences from Dimension:

- The repro uses placeholder/sanitized meeting content.
- The repro intentionally fixes the unlabeled footer action by giving it `aria-label="Copy meeting prep"`.
- The repro includes `aria-modal="true"` explicitly.

