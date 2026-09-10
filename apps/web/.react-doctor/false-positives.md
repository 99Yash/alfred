# React Doctor false positives (apps/web)

Findings that fire but are correct code by the rule's OWN validation prompt.
The `/doctor` triage playbook reads this file in its Filter step and drops
matching diagnostics. The `react-doctor` CLI itself does NOT read this file, so
these lines still appear in a raw scan — the entry is the reviewed verdict, not
a suppression.

## react-doctor/no-array-index-as-key

Rule harm model: index keys reassign React **state** across the wrong DOM nodes
when a list reorders/filters. That harm requires **stateful, per-row-identity**
rows. Every site below renders **stateless, positional** rows with no domain
id, so the harm cannot occur — and forcing a non-index key introduces a real
regression. Verified against the canonical validation prompt
(https://www.react.doctor/prompts/rules/react-doctor/no-array-index-as-key.md).

- **`src/routes/-chat/artifact-sidebar.tsx:389`** — `key={`${index}-${page.title}`}`.
  `ArtifactPage` is `{ title, html }` (see `@alfred/contracts` `artifactPageSchema`):
  no id, stored in an ordered array, position-defined. The thumbnail rail only
  navigates (onClick) — it never reorders/filters. `ArtifactPageFrame` renders a
  sandboxed `<iframe srcDoc>` driven entirely by props (no React state to
  misassign). A content-based key (hash of `html`) would change on every
  streaming delta during generation → iframe remount → flicker. Index is the
  correct positional identity. (Prior lesson: same conclusion.)
- **`src/components/approvals/input-renderer.tsx:60`** — `key={`${item}-${i}`}`
  over `stringArray(value)` (recipients/labels/tags from proposed tool input).
  Rows are stateless read-only `<Chip>{item}</Chip>`. The strings can duplicate
  (arbitrary LLM-proposed input), so a content-only `key={item}` would risk a
  duplicate-key bug for no benefit; there is no stable per-item id. Reordering
  stateless text chips cannot show/submit wrong data.
- **`src/components/approvals/question-answers-card.tsx:60` and `:75`** — `key={index}`
  over `summary.questions` / `summary.answered`. A settled `system.ask_user`
  call froze its question list when the row was written, and `askUserResultSchema`
  pairs answers to questions by position, so position IS the identity. Both rows
  are stateless read-only text (`<li>`, `<dt>`/`<dd>`); the card renders a
  finished result and offers no reorder, filter, insert, or delete. `AskUserQuestion`
  carries no id, and its `header` is a 24-character chip label the schema does
  not require to be distinct, so a content key would risk a duplicate for no
  gain. Matches the rule's suppress clause: rows with no per-item identity that
  never reorder or filter.
- **`src/components/approvals/question-panel.tsx:177`** — `key={i}` over the
  pager dots. Same frozen list, one dot per question, fixed length for the life
  of the parked row. `PagerDot` holds no state — every value it draws arrives as
  a prop — and the dot's whole purpose is to name a position (`onGo(i)`,
  "Question 3 of 4"), so an identity that is not the position would be the wrong
  one.

## react-doctor/no-effect-event-handler

- **`src/routes/-chat/approval-tray.tsx:93`** — the approval chime (toast +
  sound) for a freshly arrived batch. No event handler in this app can own it:
  `approvals` arrives over Replicache when the server parks a run, so the
  trigger is external, and the effect exists precisely to coalesce N arriving
  cards into ONE toast and one sound. Both of the rule's own suppress clauses
  apply — "the prop can change programmatically or externally" and "batching or
  coalescing is part of the behavior". The `preview` prop the detector keys on
  is a styleguide switch, not the trigger. Verified against
  https://www.react.doctor/prompts/rules/react-doctor/no-effect-event-handler.md.

## react-doctor/effect-needs-cleanup

- **`src/components/artifact-page-frame.tsx:45`** — `observer.observe(element)`.
  This is NOT a `useEffect` (the rule's stated trigger); it's a React 19
  callback ref (`frameRef`) that ends with `return () => observer.disconnect()`.
  The `ResizeObserver` is released on the exact lifecycle that created it (node
  detach). Matches the recipe's suppress case: "a returned cleanup DOES release
  this resource even if the matcher missed it." No leak.

## react-doctor/async-await-in-loop

- **`src/lib/chat/use-send-message.ts:185`** — sequential `await
rep.mutate.chatAttachmentCreate(...)` over `uploaded`. Recipe false-positive
  clause: "iterations must complete in order for correctness — ordered DB
  writes." These are ordered Replicache write mutations (each carries a
  `position`); the code comment documents the intent, and Replicache serializes
  writes internally, so `Promise.all` yields no speedup and misrepresents the
  ordering. Leave sequential.
