/**
 * Layout archetypes for the Alfred house theme (pristine-artifacts Phase 1).
 *
 * Each archetype is a body-level HTML exemplar — exactly the shape the authoring
 * model is asked to produce: content composed from the shell's `art-*` primitive
 * vocabulary, with NO `<html>/<head>/<body>` and NO page-dimension styles (the
 * shell owns those). They serve two purposes: named guidance the prompt points
 * at ("pick one archetype per page"), and in-package fixtures the shell/tests
 * render against. Full exemplars stay here rather than being dumped into the
 * prompt, keeping the authoring prompt lean.
 *
 * These are Alfred-original layouts built on the app's own light grammar — not
 * copied from any external deck library.
 */

export interface Archetype {
  /** Stable id used by the prompt and tests. */
  readonly id: string;
  /** Human name shown in guidance. */
  readonly name: string;
  /** One-line description of when to reach for it. */
  readonly description: string;
  /** Body-level HTML exemplar. */
  readonly html: string;
}

/** Cover / opening page: eyebrow, oversized title, supporting line, footer meta. */
const title: Archetype = {
  id: "title",
  name: "Title",
  description:
    "Opening or section cover — an oversized title with an eyebrow and a supporting line.",
  html: `<div class="art-aurora"></div>
<div class="art-center art-stack">
  <span class="art-eyebrow">Quarterly review</span>
  <h1 class="art-display">The year in one page</h1>
  <p class="art-subhead art-muted">A concise look at what moved, what stalled, and where we go next.</p>
  <div class="art-accent-mark" style="margin-top: 12px;"></div>
</div>
<div class="art-row art-between" style="margin-top: auto;">
  <span class="art-caption">Alfred</span>
  <span class="art-caption">2026</span>
</div>`,
};

/** Section divider: a large index number + section name to break up a deck. */
const section: Archetype = {
  id: "section",
  name: "Section divider",
  description: "A palate-cleanser between sections — a big index number and the section name.",
  html: `<div class="art-aurora"></div>
<div class="art-center art-row" style="gap: 32px;">
  <span class="art-display art-accent-text" style="font-size: 140px;">02</span>
  <div class="art-stack" style="gap: 8px;">
    <span class="art-eyebrow">Section</span>
    <h2 class="art-title">How the work landed</h2>
    <p class="art-body art-muted">Three shipped bets and what each one taught us.</p>
  </div>
</div>`,
};

/** Content-split: a heading + prose on the left, a supporting card on the right. */
const contentSplit: Archetype = {
  id: "content-split",
  name: "Content split",
  description:
    "Asymmetric two-column — narrative on one side, a supporting card or figure on the other.",
  html: `<div class="art-stack" style="gap: 8px; margin-bottom: 32px;">
  <span class="art-eyebrow">Overview</span>
  <h2 class="art-headline">A calmer inbox, by default</h2>
</div>
<div class="art-split art-fill">
  <div class="art-stack">
    <p class="art-body">Triage now runs before you wake up, so the first thing you see is a short, ranked list instead of a wall of unread mail.</p>
    <p class="art-body art-muted">Everything else stays in Gmail untouched. Nothing is deleted; it is only reordered by what needs you.</p>
  </div>
  <div class="art-card art-stack">
    <span class="art-eyebrow">At a glance</span>
    <div><div class="art-stat-value">3</div><div class="art-stat-label">threads need a reply</div></div>
    <hr class="art-rule" />
    <div><div class="art-stat-value">18</div><div class="art-stat-label">quietly filed</div></div>
  </div>
</div>`,
};

/** Bulleted list: a heading + an accent-marked list of points. */
const list: Archetype = {
  id: "list",
  name: "Bulleted list",
  description: "A heading followed by a small set of scannable points with accent markers.",
  html: `<div class="art-stack" style="gap: 8px; margin-bottom: 32px;">
  <span class="art-eyebrow">What changed</span>
  <h2 class="art-headline">Three things are new this week</h2>
</div>
<ul class="art-list art-fill" style="justify-content: center;">
  <li><span class="art-body">Morning briefings arrive as a single card, not five separate notifications.</span></li>
  <li><span class="art-body">You can ask Alfred to build a deck or doc and read it in the side panel.</span></li>
  <li><span class="art-body">Sender suppression is one tap and never touches your actual mailbox.</span></li>
</ul>`,
};

/** Stat / CSS chart: a headline metric row plus a pure-CSS bar chart. */
const stat: Archetype = {
  id: "stat",
  name: "Stat / chart",
  description: "Headline numbers and a pure-CSS bar chart — no scripts, sized with inline widths.",
  html: `<div class="art-stack" style="gap: 8px; margin-bottom: 32px;">
  <span class="art-eyebrow">Impact</span>
  <h2 class="art-headline">Time back, measured</h2>
</div>
<div class="art-grid-2 art-fill" style="align-items: center;">
  <div class="art-row" style="gap: 48px;">
    <div><div class="art-stat-value">6.2h</div><div class="art-stat-label">saved per week</div></div>
    <div><div class="art-stat-value">92%</div><div class="art-stat-label">triaged automatically</div></div>
  </div>
  <div class="art-stack">
    <div class="art-stack" style="gap: 6px;">
      <span class="art-caption">Email</span>
      <div class="art-bar-track"><div class="art-bar-fill" style="width: 84%;"></div></div>
    </div>
    <div class="art-stack" style="gap: 6px;">
      <span class="art-caption">Calendar</span>
      <div class="art-bar-track"><div class="art-bar-fill" style="width: 61%;"></div></div>
    </div>
    <div class="art-stack" style="gap: 6px;">
      <span class="art-caption">Research</span>
      <div class="art-bar-track"><div class="art-bar-fill" style="width: 47%;"></div></div>
    </div>
  </div>
</div>`,
};

/** Quote / pull-out: a large centered statement with attribution. */
const quote: Archetype = {
  id: "quote",
  name: "Quote",
  description: "A single large pull-quote or statement, centered, with quiet attribution.",
  html: `<div class="art-center art-stack" style="gap: 32px;">
  <div class="art-accent-mark"></div>
  <blockquote class="art-title" style="font-weight: 650; max-width: 900px;">"It finally feels like something is watching my inbox so I don't have to."</blockquote>
  <div class="art-row" style="gap: 12px;">
    <span class="art-dot"></span>
    <span class="art-caption">Early access user, week three</span>
  </div>
</div>`,
};

/** The house archetype set, in a sensible authoring order. */
export const archetypes: readonly Archetype[] = [title, section, contentSplit, list, stat, quote];

/** Look up an archetype by id (used by tests / tooling). */
export function archetypeById(id: string): Archetype | undefined {
  return archetypes.find((a) => a.id === id);
}
