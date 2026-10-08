/**
 * Body-level slide layouts built from the shell's `art-*` classes.
 * The prompt names them; the full HTML stays here to keep the prompt small.
 */

export interface Archetype {
  /** Stable id. */
  readonly id: string;
  /** Name shown in the prompt. */
  readonly name: string;
  /** When to use it. */
  readonly description: string;
  readonly html: string;
}

/** Cover page. */
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

/** Section divider with a large number. */
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

/** Text on the left, a card on the right. */
const contentSplit: Archetype = {
  id: "content-split",
  name: "Content split",
  description:
    "Asymmetric two-column — narrative on one side, a supporting card or figure on the other.",
  html: `<div class="art-stack" style="gap: 6px; margin-bottom: 44px;">
  <span class="art-eyebrow">Overview</span>
  <h2 class="art-headline">A calmer inbox, by default</h2>
</div>
<div class="art-split art-fill" style="align-items: stretch;">
  <div class="art-stack" style="justify-content: center; gap: 20px;">
    <p class="art-subhead">Triage runs before you wake up, so the first thing you see is a short, ranked list instead of a wall of unread mail.</p>
    <p class="art-body art-muted">Everything else stays in Gmail, untouched. Nothing is deleted; it is only reordered by what actually needs you.</p>
  </div>
  <div class="art-card art-stack" style="justify-content: center; gap: 18px;">
    <span class="art-eyebrow">At a glance</span>
    <div><div class="art-stat-value art-nums">3</div><div class="art-stat-label">threads need a reply</div></div>
    <hr class="art-rule" />
    <div><div class="art-stat-value art-nums">18</div><div class="art-stat-label">quietly filed</div></div>
  </div>
</div>`,
};

/** Heading and a bulleted list. */
const list: Archetype = {
  id: "list",
  name: "Bulleted list",
  description: "A heading followed by a small set of scannable points with accent markers.",
  html: `<div class="art-stack" style="gap: 6px; margin-bottom: 40px;">
  <span class="art-eyebrow">What changed</span>
  <h2 class="art-headline">Three things are new this week</h2>
</div>
<ul class="art-list art-fill" style="justify-content: center; gap: 28px;">
  <li>
    <div class="art-stack" style="gap: 4px;">
      <span class="art-subhead">One morning card</span>
      <span class="art-body art-muted">Briefings arrive as a single card, not five separate notifications.</span>
    </div>
  </li>
  <li>
    <div class="art-stack" style="gap: 4px;">
      <span class="art-subhead">Decks and docs on demand</span>
      <span class="art-body art-muted">Ask Alfred to build one and read it in the side panel, no export step.</span>
    </div>
  </li>
  <li>
    <div class="art-stack" style="gap: 4px;">
      <span class="art-subhead">Quiet a sender in one tap</span>
      <span class="art-body art-muted">Suppression never touches your actual mailbox or deletes a thing.</span>
    </div>
  </li>
</ul>`,
};

/** Metric row and a CSS bar chart. */
const stat: Archetype = {
  id: "stat",
  name: "Stat / chart",
  description: "Headline numbers and a pure-CSS bar chart — no scripts, sized with inline widths.",
  html: `<div class="art-stack" style="gap: 6px; margin-bottom: 40px;">
  <span class="art-eyebrow">Impact</span>
  <h2 class="art-headline">Time back, measured</h2>
</div>
<div class="art-fill art-stack" style="justify-content: center; gap: 48px;">
  <div class="art-row" style="gap: 72px;">
    <div><div class="art-stat-value art-nums">6.2h</div><div class="art-stat-label">saved per week</div></div>
    <div><div class="art-stat-value art-nums">92%</div><div class="art-stat-label">triaged automatically</div></div>
    <div><div class="art-stat-value art-nums">3.1k</div><div class="art-stat-label">emails handled</div></div>
  </div>
  <div class="art-stack" style="gap: 18px;">
    <div class="art-stack" style="gap: 8px;">
      <div class="art-row art-between"><span class="art-caption">Email</span><span class="art-caption art-subtle art-nums">84%</span></div>
      <div class="art-bar-track"><div class="art-bar-fill" style="width: 84%;"></div></div>
    </div>
    <div class="art-stack" style="gap: 8px;">
      <div class="art-row art-between"><span class="art-caption">Calendar</span><span class="art-caption art-subtle art-nums">61%</span></div>
      <div class="art-bar-track"><div class="art-bar-fill" style="width: 61%;"></div></div>
    </div>
    <div class="art-stack" style="gap: 8px;">
      <div class="art-row art-between"><span class="art-caption">Research</span><span class="art-caption art-subtle art-nums">47%</span></div>
      <div class="art-bar-track"><div class="art-bar-fill" style="width: 47%;"></div></div>
    </div>
  </div>
</div>`,
};

/** Large centered quote. */
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

/** All slide archetypes. */
export const archetypes: readonly Archetype[] = [title, section, contentSplit, list, stat, quote];

/** Find an archetype by id. */
export function archetypeById(id: string): Archetype | undefined {
  return archetypes.find((a) => a.id === id);
}
