import { getSubAgentModel, meteredGenerateText, stepCountIs } from "@alfred/ai";
import { settleTaskGroup } from "@alfred/contracts";
import type { IdentityAnchor } from "./seed";
import type { ColdStartSignals } from "./signals";
import { buildColdStartWebTool } from "./web-tool";

/**
 * Cold-start v2 — step 2 of the agent harness: bounded parallel aspect
 * sub-agents (ADR-0011/0022 amendment).
 *
 * Each aspect is a focused web-research sub-agent: a sub-agent-tier model with
 * a local `web_search` tool, capped at a few searches, that returns ~500 words
 * of dense findings on one facet of the user. They run concurrently (one boss
 * identity anchor in, N findings out) and feed the boss synthesis step.
 *
 * The aspect set is deterministic and small — "bounded" in the design's sense —
 * rather than model-chosen: it's the same handful of facets we extract facts
 * for, filtered by signal (e.g. skip the employer aspect for a consumer email).
 * The seed's identity anchor is injected into every brief so all aspects chase
 * the same person.
 */

const ASPECT_MAX_STEPS = 4;
/** Findings are ephemeral run-state; the cap keeps the synthesis prompt lean. */
const ASPECT_MAX_OUTPUT_TOKENS = 1_200;

export interface ColdStartAspect {
  id: string;
  label: string;
  /** The facet-specific research instruction handed to the sub-agent. */
  brief: string;
}

export interface AspectFinding {
  id: string;
  label: string;
  /** ~500-word dense findings, or an explicit "nothing found". */
  finding: string;
  citations: string[];
}

/**
 * The deterministic aspect set. `company` is dropped for consumer email
 * domains (no employer to research); the rest always run. Briefs carry the
 * relation/confidence guards inline so each sub-agent stays conservative.
 */
export function selectAspects(signals: ColdStartSignals): ColdStartAspect[] {
  const aspects: ColdStartAspect[] = [
    {
      id: "professional",
      label: "Professional",
      brief:
        "Establish the person's current professional identity: role/title, current employer, team or focus area, and the city/region they're based in if publicly stated. Draw from LinkedIn, company team pages, conference bios, GitHub profile, or a personal site. Attribute every claim to a source; flag anything you can only state tentatively.",
    },
    {
      id: "online",
      label: "Online presence & work",
      brief:
        "Find the person's public online footprint that you can confidently attribute to THIS individual: personal website, GitHub username, X/Twitter handle, LinkedIn URL, plus any notable public projects, open-source work, writing, or talks. Mark each handle/link as high-confidence or tentative. Skip anything you can't tie to the right person.",
    },
    {
      id: "personal",
      label: "Personal context",
      brief:
        "Find personal context only where a public source explicitly attests it: marital status, a publicly named spouse/partner, and family. RELATION GUARD: attestation, not fame — never infer a relationship from a shared surname, city, or coincidence; hedge or omit anything low-confidence. For any family member who is themselves a public figure, add one line on what makes them notable. For minor children, 'they exist / how many' is the most you report — no individual background on a minor. If nothing is publicly attested, say so plainly.",
    },
  ];

  if (signals.emailDomain && !signals.emailDomainIsConsumer) {
    aspects.splice(1, 0, {
      id: "company",
      label: "Employer",
      brief: `Research the company at the domain "${signals.emailDomain}" — presumably the person's employer. One tight paragraph: what they do, rough size, stage/funding, and headquarters. Cite the company site or a reputable profile.`,
    });
  }

  return aspects;
}

const SYSTEM_PROMPT = `You are one of several parallel research sub-agents in a personal AI assistant's self-onboarding. The user is setting up the assistant for themselves over their own public footprint. You research ONE focused facet and report dense, citation-grounded findings.

How to work:
- Run a few focused web searches scoped to YOUR facet only. Reuse the identity anchor's distinguishing details so you research the right person.
- Be CONSERVATIVE. False facts erode trust more than gaps do. If the anchor says no confident match, or your searches turn up nothing you can attribute to this exact person, say "nothing publicly found for this facet" and stop — do not pad with low-confidence guesses about people who merely share the name.
- Public sources only. Never report contact details (home address, personal phone, email address, exact birthdate).

Output (~500 words max): dense prose findings for your facet, with inline source attributions. No preamble, no restating these instructions, no meta-commentary about how you searched. Lead with the strongest, best-attested findings.`;

function buildPrompt(args: {
  signals: ColdStartSignals;
  anchor: IdentityAnchor;
  aspect: ColdStartAspect;
}): string {
  const lines: string[] = [];
  lines.push(`Subject:`);
  lines.push(`- Name: ${args.signals.name}`);
  // Deliberately NOT the full email — the local-part is a contact detail that
  // adds nothing to web research and would otherwise ride into the checkpointed
  // finding + synthesis. The resolved anchor + domain disambiguate. (Identity
  // resolution in the `seed` step is the only place the full email belongs.)
  if (args.signals.emailDomain) lines.push(`- Email domain: ${args.signals.emailDomain}`);
  lines.push("");
  lines.push(`Identity anchor (from the resolution step — treat as ground truth):`);
  lines.push(args.anchor.anchor);
  lines.push("");
  lines.push(`Your facet — ${args.aspect.label}:`);
  lines.push(args.aspect.brief);
  return lines.join("\n");
}

async function runAspect(args: {
  signals: ColdStartSignals;
  anchor: IdentityAnchor;
  aspect: ColdStartAspect;
  runId?: string;
  idempotencyKey?: string;
  abortSignal?: AbortSignal;
}): Promise<AspectFinding> {
  const stepId = `aspect:${args.aspect.id}`;
  const web = buildColdStartWebTool({
    userId: args.signals.userId,
    runId: args.runId,
    stepId,
    abortSignal: args.abortSignal,
  });

  const result = await meteredGenerateText(
    {
      model: getSubAgentModel(),
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(args),
      tools: web.tools,
      stopWhen: stepCountIs(ASPECT_MAX_STEPS),
      maxOutputTokens: ASPECT_MAX_OUTPUT_TOKENS,
      temperature: 0,
      abortSignal: args.abortSignal,
    },
    {
      kind: "llm",
      userId: args.signals.userId,
      runId: args.runId,
      stepId,
      idempotencyKey: args.idempotencyKey ? `${args.idempotencyKey}:${args.aspect.id}` : undefined,
      requestMeta: { purpose: `cold-start.aspect`, aspect: args.aspect.id },
      name: `cold-start.aspect:${args.aspect.id}`,
    },
  );

  return {
    id: args.aspect.id,
    label: args.aspect.label,
    finding: result.text.trim(),
    citations: web.citations,
  };
}

export interface ResearchAspectsArgs {
  signals: ColdStartSignals;
  anchor: IdentityAnchor;
  runId?: string;
  /** Stable per-run key; each aspect derives its own from this + aspect id. */
  idempotencyKey?: string;
}

/**
 * Fan the aspect set out concurrently. If one aspect throws, abort the shared
 * provider/web-search signal so sibling loops don't keep spending API calls in
 * the background. The workflow still degrades to explicit empty findings after
 * the task group has settled, preserving cold-start's best-effort contract.
 */
export async function researchAspects(args: ResearchAspectsArgs): Promise<AspectFinding[]> {
  const aspects = selectAspects(args.signals);
  const settled = await settleTaskGroup(
    aspects.map(
      (aspect) =>
        async ({ signal }) =>
          runAspect({
            signals: args.signals,
            anchor: args.anchor,
            aspect,
            runId: args.runId,
            idempotencyKey: args.idempotencyKey,
            abortSignal: signal,
          }),
    ),
  );

  return settled.map((result, index): AspectFinding => {
    if (result.status === "fulfilled") return result.value;
    const aspect = aspects[index] as ColdStartAspect;
    return {
      id: aspect.id,
      label: aspect.label,
      finding: "nothing publicly found for this facet (research step failed)",
      citations: [],
    };
  });
}
