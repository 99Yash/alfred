# React Doctor false positives (apps/web)

Findings that fire but are correct code by the rule's OWN validation prompt.
The `/doctor` triage playbook reads this file in its Filter step and drops
matching diagnostics. The `react-doctor` CLI itself does NOT read this file, so
these lines still appear in a raw scan — the entry is the reviewed verdict, not
a suppression.

## react-doctor/no-array-index-as-key

Rule harm model: index keys reassign React **state** across the wrong DOM nodes
when a list reorders/filters. That harm requires **stateful, per-row-identity**
rows. Both sites below render **stateless, positional** rows with no domain id,
so the harm cannot occur — and forcing a non-index key introduces a real
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
