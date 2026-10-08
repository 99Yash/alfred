import { route, isStepCount, meteredGenerateText } from "@alfred/ai";
import type { IdentityAnchor } from "./seed";
import type { ColdStartSignals } from "./signals";
import { buildColdStartWebTool } from "./web-tool";

/**
 * Cold-start step 3: parallel sub-agents, one per facet of the user, each with a capped
 * `web_search` loop (ADR-0011/0022). The set is fixed, not model-chosen.
 */

const ASPECT_MAX_STEPS = 4;

/** Findings are run-state only; the cap keeps the synthesis prompt small. */
const ASPECT_MAX_OUTPUT_TOKENS = 1_200;

export interface ColdStartAspect {
  id: string;
  label: string;
  brief: string;
}

export interface AspectFinding {
  id: string;
  label: string;
  finding: string;
  citations: string[];
}

/** Drop `company` for a consumer email domain; it has no employer to research. */
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

  // Domain only: the local-part adds nothing to research and must not reach the persisted finding.
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
  runId?: string | undefined;
  idempotencyKey?: string | undefined;
  abortSignal?: AbortSignal | undefined;
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
      model: route("subAgent").model(),
      instructions: SYSTEM_PROMPT,
      prompt: buildPrompt(args),
      tools: web.tools,
      stopWhen: isStepCount(ASPECT_MAX_STEPS),
      maxOutputTokens: ASPECT_MAX_OUTPUT_TOKENS,
      temperature: 0,
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    },
    {
      kind: "llm",
      role: "cold_start",
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
  /** Each aspect derives its own key from this and its id. */
  idempotencyKey?: string;
}

/** Run all aspects at once. A failed aspect becomes an empty finding and does not cancel the others. */
export async function researchAspects(args: ResearchAspectsArgs): Promise<AspectFinding[]> {
  return Promise.all(
    selectAspects(args.signals).map(async (aspect) => {
      try {
        return await runAspect({
          signals: args.signals,
          anchor: args.anchor,
          aspect,
          runId: args.runId,
          idempotencyKey: args.idempotencyKey,
        });
      } catch {
        return emptyAspectFinding(aspect);
      }
    }),
  );
}

function emptyAspectFinding(aspect: ColdStartAspect): AspectFinding {
  return {
    id: aspect.id,
    label: aspect.label,
    finding: "nothing publicly found for this facet (research step failed)",
    citations: [],
  };
}
