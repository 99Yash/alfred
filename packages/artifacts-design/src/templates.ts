/**
 * Body-level `pdf` page templates built from the `art-doc-*` classes.
 * Without one, the model wrote its own tiny, off-brand type. The PDF prompt
 * inlines the resume; it names the others.
 */

export interface DocumentTemplate {
  /** Stable id. */
  readonly id: string;
  /** Name shown in the prompt. */
  readonly name: string;
  readonly format: "pdf";
  /** When to use it. */
  readonly description: string;
  /** Body-level HTML for inside `.art-page`. */
  readonly html: string;
}

/** Resume: header, summary, experience, and a skills and education footer. */
const resume: DocumentTemplate = {
  id: "resume",
  name: "Résumé / CV",
  format: "pdf",
  description:
    "A one-page résumé: header + contact, summary, experience, and a skills/education footer.",
  html: `<div class="art-doc">
  <div class="art-doc-header">
    <div>
      <div class="art-doc-name">[Full name]</div>
      <div class="art-doc-role">[Current or target role]</div>
    </div>
    <div class="art-doc-contact">
      [Portfolio URL]<br />
      [GitHub URL]<br />
      [LinkedIn URL]<br />
      [Email address]
    </div>
  </div>
  <hr class="art-doc-headrule" />

  <div class="art-doc-lede">[One verified sentence summarizing scope, strengths, and the kind of outcomes delivered.]</div>

  <div class="art-doc-sectionhead"><div class="art-doc-section">Experience</div></div>
  <div class="art-doc-entry">
    <div class="art-doc-entry-head">
      <div class="art-doc-entry-title">[Company] <span>&middot; [Role]</span></div>
      <div class="art-doc-entry-meta">[Start to end]</div>
    </div>
    <div class="art-doc-entry-desc">[Verified responsibility or accomplishment, including a metric only when the source provides one.]</div>
  </div>
  <div class="art-doc-entry">
    <div class="art-doc-entry-head">
      <div class="art-doc-entry-title">[Company] <span>&middot; [Role]</span></div>
      <div class="art-doc-entry-meta">[Start to end]</div>
    </div>
    <div class="art-doc-entry-desc">[Verified responsibility or accomplishment.]</div>
  </div>
  <div class="art-doc-entry">
    <div class="art-doc-entry-head">
      <div class="art-doc-entry-title">[Company] <span>&middot; [Role]</span></div>
      <div class="art-doc-entry-meta">[Start to end]</div>
    </div>
    <div class="art-doc-entry-desc">[Verified responsibility or accomplishment.]</div>
  </div>
  <div class="art-doc-entry">
    <div class="art-doc-entry-head">
      <div class="art-doc-entry-title">[Company] <span>&middot; [Role]</span></div>
      <div class="art-doc-entry-meta">[Start to end]</div>
    </div>
    <div class="art-doc-entry-desc">[Verified responsibility or accomplishment.]</div>
  </div>

  <div class="art-doc-sectionhead"><div class="art-doc-section">Selected projects</div></div>
  <div class="art-doc-entry">
    <div class="art-doc-entry-head">
      <div class="art-doc-entry-title">[Project] <span>&middot; [What it is]</span></div>
      <div class="art-doc-entry-meta">[Verified signal]</div>
    </div>
    <div class="art-doc-entry-desc">[Verified outcome or distinctive technical contribution.]</div>
  </div>

  <div class="art-doc-cols">
    <div>
      <div class="art-doc-section">Skills</div>
      <div class="art-doc-chips">
        <span class="art-doc-chip">[Skill]</span>
        <span class="art-doc-chip">[Skill]</span>
        <span class="art-doc-chip">[Skill]</span>
        <span class="art-doc-chip">[Skill]</span>
      </div>
    </div>
    <div>
      <div class="art-doc-section">Education</div>
      <div class="art-doc-entry">
        <div class="art-doc-entry-title">[Institution]</div>
        <div class="art-doc-entry-desc">[Credential] &middot; [Year]</div>
      </div>
    </div>
  </div>
</div>`,
};

/** Report: title, lede, two sections, and a takeaway panel. */
const report: DocumentTemplate = {
  id: "report",
  name: "Report / brief",
  format: "pdf",
  description:
    "A single-page report: title + meta, summary, headed prose sections, and a takeaway panel.",
  html: `<div class="art-doc">
  <div class="art-doc-header">
    <div>
      <div class="art-doc-name">Q3 Reliability Review</div>
      <div class="art-doc-role">Platform Engineering</div>
    </div>
    <div class="art-doc-contact">Prepared by A. Chen<br />October 2026</div>
  </div>
  <hr class="art-doc-headrule" />

  <div class="art-doc-lede">Uptime held at 99.95 percent through the quarter. Two incidents drove the remaining budget; both are now covered by automated failover.</div>

  <div class="art-doc-sectionhead"><div class="art-doc-section">By the numbers</div></div>
  <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px;">
    <div class="art-panel"><div class="art-doc-name art-nums">99.95%</div><div class="art-doc-meta">uptime, up from 99.9</div></div>
    <div class="art-panel"><div class="art-doc-name art-nums">+60%</div><div class="art-doc-meta">traffic, flat median latency</div></div>
    <div class="art-panel"><div class="art-doc-name art-nums">30s</div><div class="art-doc-meta">failover detection window</div></div>
  </div>

  <div class="art-doc-sectionhead"><div class="art-doc-section">What happened</div></div>
  <p class="art-doc-entry-desc" style="color: var(--art-ink); margin: 0;">Traffic grew 60 percent quarter over quarter with no added latency at the median. The two incidents that consumed error budget were both single-region database failovers that took longer than target to promote a replica.</p>

  <div class="art-doc-sectionhead"><div class="art-doc-section">What we changed</div></div>
  <p class="art-doc-entry-desc" style="color: var(--art-ink); margin: 0;">Promotion is now automated with a 30-second detection window, and read traffic sheds to a warm standby on failure. We added synthetic checks per region so a partial outage pages before customers notice.</p>

  <div class="art-panel" style="border-left: 3px solid var(--art-accent); margin-top: 28px;">
    <div class="art-doc-section" style="margin-bottom: 4px;">Takeaway</div>
    <div style="font-size: var(--art-doc-role);">Automated failover closes the gap that cost us this quarter. Next: extend it to the analytics tier.</div>
  </div>
</div>`,
};

/** One-pager: header, lede, a three-column value grid, and a closing line. Uses the accent most. */
const onePager: DocumentTemplate = {
  id: "one-pager",
  name: "One-pager",
  format: "pdf",
  description:
    "A product or project one-pager: name + tagline, positioning line, a three-up value grid, closing line.",
  html: `<div class="art-doc">
  <div class="art-doc-header">
    <div>
      <span class="art-eyebrow">Product brief</span>
      <div class="art-doc-name" style="margin-top: 6px;">Harbor</div>
      <div class="art-doc-role">The calm inbox for busy teams.</div>
    </div>
  </div>

  <div class="art-doc-lede" style="max-width: 78%;">Harbor triages your mail before you wake up, so the first thing you see is a short ranked list of what needs you, not a wall of unread.</div>

  <div class="art-doc-sectionhead"><div class="art-doc-section">Why it matters</div></div>
  <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;">
    <div class="art-doc-entry">
      <div class="art-doc-entry-title">Ranked, not raw</div>
      <div class="art-doc-entry-desc">One ordered list by what needs a reply, filed automatically underneath.</div>
    </div>
    <div class="art-doc-entry">
      <div class="art-doc-entry-title">Nothing deleted</div>
      <div class="art-doc-entry-desc">Your mailbox is untouched. Harbor only reorders what you see.</div>
    </div>
    <div class="art-doc-entry">
      <div class="art-doc-entry-title">One tap to quiet</div>
      <div class="art-doc-entry-desc">Suppress a noisy sender without a single filter rule.</div>
    </div>
  </div>

  <div class="art-doc-sectionhead"><div class="art-doc-section">How it works</div></div>
  <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;">
    <div class="art-doc-entry">
      <div class="art-doc-entry-title art-accent-text">01</div>
      <div class="art-doc-entry-desc">Connect Gmail with one tap. Nothing leaves your account.</div>
    </div>
    <div class="art-doc-entry">
      <div class="art-doc-entry-title art-accent-text">02</div>
      <div class="art-doc-entry-desc">Harbor triages overnight and ranks what needs you.</div>
    </div>
    <div class="art-doc-entry">
      <div class="art-doc-entry-title art-accent-text">03</div>
      <div class="art-doc-entry-desc">Wake up to a short list, not a full inbox.</div>
    </div>
  </div>

  <div class="art-doc-sectionhead"><div class="art-doc-section">Proof</div></div>
  <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px;">
    <div class="art-panel"><div class="art-doc-name art-nums">6.2h</div><div class="art-doc-meta">saved per week</div></div>
    <div class="art-panel"><div class="art-doc-name art-nums">92%</div><div class="art-doc-meta">triaged automatically</div></div>
    <div class="art-panel"><div class="art-doc-name art-nums">5 min</div><div class="art-doc-meta">to set up</div></div>
  </div>

  <hr class="art-doc-rule" />
  <div class="art-row art-between">
    <span class="art-doc-role art-ink">Ready in five minutes. Connect Gmail and go.</span>
    <span class="art-doc-meta art-accent-text">harbor.app</span>
  </div>
</div>`,
};

/** All document templates. */
export const documentTemplates: readonly DocumentTemplate[] = [resume, report, onePager];

/** Find a document template by id. */
export function documentTemplateById(id: string): DocumentTemplate | undefined {
  return documentTemplates.find((t) => t.id === id);
}
