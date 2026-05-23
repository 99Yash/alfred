/**
 * Fixture data for /preview/skills + /preview/skills/$slug.
 *
 * Shared between the list and detail pages so a slug clicked on the
 * list lands on the matching content. No Replicache wiring — these
 * are static demos of the visitors-now grammar.
 *
 * Memory bodies are markdown so the detail page can render them with
 * the same styling once real skills land.
 */

export type PreviewSkillTint = "violet" | "sky" | "amber" | "emerald";

export interface PreviewSkillRun {
  id: string;
  kind: "learn" | "re-learn";
  status: "completed" | "running" | "failed";
  startedAt: string;
  endedAt?: string;
  revisionId?: string;
}

export interface PreviewSkill {
  slug: string;
  name: string;
  description: string;
  status: "active" | "draft";
  tint: PreviewSkillTint;
  prompt: string;
  memoryBody: string;
  lastRunAt: string;
  updatedAt: string;
  integrations: ReadonlyArray<string>;
  runs: ReadonlyArray<PreviewSkillRun>;
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

export const PREVIEW_SKILLS: ReadonlyArray<PreviewSkill> = [
  {
    slug: "engineering-recruiting",
    name: "Engineering recruiting filters",
    description: "Hard rules for the engineering job hunt — filter aggressively.",
    status: "active",
    tint: "violet",
    integrations: ["Gmail"],
    prompt:
      "I want you to learn that I am still applying for jobs and ideally looking for something truly remote, with $40k/yr or beyond.",
    memoryBody: [
      "- **Filter** for fully remote roles only; reject any requiring in-office or hybrid.",
      "- **Set** salary floor at $40,000/year for all opportunities.",
      "- **Target** Fullstack Engineer, Founding Engineer, AI Engineer roles.",
      "- **Prioritize** early-stage VC-backed startups in 0-to-1 phase.",
    ].join("\n"),
    lastRunAt: hoursAgo(3),
    updatedAt: hoursAgo(3),
    runs: [
      {
        id: "r_eng_3",
        kind: "re-learn",
        status: "completed",
        startedAt: hoursAgo(3),
        endedAt: hoursAgo(2.95),
        revisionId: "rev_eng_3",
      },
      {
        id: "r_eng_2",
        kind: "re-learn",
        status: "completed",
        startedAt: daysAgo(2),
        endedAt: daysAgo(1.98),
        revisionId: "rev_eng_2",
      },
      {
        id: "r_eng_1",
        kind: "learn",
        status: "completed",
        startedAt: daysAgo(6),
        endedAt: daysAgo(5.99),
        revisionId: "rev_eng_1",
      },
    ],
  },
  {
    slug: "writing-voice",
    name: "Writing voice",
    description: "Tone, cadence, and the words I never want Alfred to use.",
    status: "active",
    tint: "sky",
    integrations: ["Gmail", "Notes"],
    prompt:
      "Match my writing voice across every email and draft. Concise, no exclamation marks, never use 'utilize', 'leverage', or 'just'. Prefer dashes over commas for asides.",
    memoryBody: [
      "- **Tone:** concise, direct; default to fewer words.",
      "- **Banned phrases:** _utilize_, _leverage_, _just_, _stoked_, _excited to share_.",
      "- **Punctuation:** dashes over commas for asides; never trailing exclamation marks.",
      "- **Email sign-off:** \"— Y\" on internal threads; \"Best, Yash\" on external.",
    ].join("\n"),
    lastRunAt: daysAgo(1),
    updatedAt: daysAgo(1),
    runs: [
      {
        id: "r_voice_2",
        kind: "re-learn",
        status: "completed",
        startedAt: daysAgo(1),
        endedAt: daysAgo(0.99),
        revisionId: "rev_voice_2",
      },
      {
        id: "r_voice_1",
        kind: "learn",
        status: "completed",
        startedAt: daysAgo(9),
        endedAt: daysAgo(8.99),
        revisionId: "rev_voice_1",
      },
    ],
  },
  {
    slug: "investor-updates",
    name: "Investor updates",
    description: "Sycamore-style monthly investor update template.",
    status: "draft",
    tint: "amber",
    integrations: ["Gmail"],
    prompt:
      "Help me draft monthly investor updates following the Sycamore template — Highlights, Lowlights, Asks. Always lead with a one-line TL;DR.",
    memoryBody: "",
    lastRunAt: "",
    updatedAt: daysAgo(4),
    runs: [],
  },
  {
    slug: "code-review",
    name: "Code review preferences",
    description: "What I want surfaced first in any PR review.",
    status: "active",
    tint: "emerald",
    integrations: ["GitHub"],
    prompt:
      "When reviewing PRs, surface correctness bugs before style, prefer comments on the diff lines themselves over PR-level summaries, and never approve a PR that adds a TODO without a tracking issue.",
    memoryBody: [
      "- **Order of severity:** correctness > security > performance > naming > style.",
      "- **Comment placement:** inline on the diff, not PR-level summary.",
      "- **TODOs:** require a tracking issue link or the PR doesn't get an approval.",
      "- **Test coverage:** new files must arrive with a smoke test; refactors must keep coverage flat or higher.",
    ].join("\n"),
    lastRunAt: daysAgo(5),
    updatedAt: daysAgo(5),
    runs: [
      {
        id: "r_cr_1",
        kind: "learn",
        status: "completed",
        startedAt: daysAgo(5),
        endedAt: daysAgo(4.99),
        revisionId: "rev_cr_1",
      },
    ],
  },
];

export function findPreviewSkill(slug: string): PreviewSkill | undefined {
  return PREVIEW_SKILLS.find((s) => s.slug === slug);
}
