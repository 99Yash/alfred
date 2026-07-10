/**
 * Document templates for the `pdf` medium (pristine-artifacts Phase 2a).
 *
 * Where `archetypes.ts` covers SLIDE layouts (one idea per 1280x720 page), these
 * cover DOCUMENTS — a resume, a report page, a product one-pager — the dense,
 * read-up-close 816x1056 medium the slide archetypes do not serve. Each is a
 * complete, on-token body-level page built from the `art-doc-*` vocabulary and
 * the `--art-doc-*` type scale, sized to fill the sheet.
 *
 * They exist because live use proved the failure mode: asked for a "resume,"
 * the model had no document exemplar to compose from, so it hand-rolled a
 * page-level `<style>` with hardcoded Apple greys and a 10.5px base — off-brand,
 * cramped, and stranding the bottom half of the page. A real house-styled
 * template is the anchor that keeps document output on the system; the resume
 * (the most-requested and worst-regressed) is inlined into the authoring prompt,
 * the rest stay in-package as named guidance + render fixtures.
 *
 * Same contract as archetypes: body-level HTML only (no <html>/<head>/<body>,
 * no page-dimension styles — the shell owns those), all color/type from tokens.
 * Placeholder content is generic on purpose; the model swaps in the real facts.
 */

export interface DocumentTemplate {
  /** Stable id used by the prompt and tests. */
  readonly id: string;
  /** Human name shown in guidance. */
  readonly name: string;
  /** The format this template is authored for. */
  readonly format: "pdf";
  /** One-line description of when to reach for it. */
  readonly description: string;
  /** Body-level HTML exemplar (goes inside the shell's `.art-page`). */
  readonly html: string;
}

/**
 * Résumé / CV — the anchor template. A header (name + role, contact stack), a
 * one-line summary, an experience list, and a two-column skills + education
 * footer. Uses the document type scale (readable, not tiny) and fills the page
 * top to bottom.
 */
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

/**
 * Report / brief — a titled document page: title + meta line, a lede, two headed
 * prose sections, and a highlighted takeaway panel. For a memo, summary, or
 * single-page write-up.
 */
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

/**
 * One-pager — a product / project brief: name + tagline header, a positioning
 * lede, a three-up value grid, and a closing line. Slightly warmer; the one
 * document template that leans on the accent.
 */
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

  <hr class="art-doc-rule" />
  <div class="art-row art-between">
    <span class="art-doc-role art-ink">Ready in five minutes. Connect Gmail and go.</span>
    <span class="art-doc-meta art-accent-text">harbor.app</span>
  </div>
</div>`,
};

/** The house document-template set, in a sensible authoring order. */
export const documentTemplates: readonly DocumentTemplate[] = [resume, report, onePager];

/** Look up a document template by id (used by the prompt / tests / tooling). */
export function documentTemplateById(id: string): DocumentTemplate | undefined {
  return documentTemplates.find((t) => t.id === id);
}
