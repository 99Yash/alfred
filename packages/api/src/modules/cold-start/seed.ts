import { getBossModel, meteredGenerateText, stepCountIs } from "@alfred/ai";
import type { ColdStartSignals } from "./signals";
import { buildColdStartWebTool } from "./web-tool";

/**
 * Cold-start v2 — step 1 of the agent harness: boss identity resolution
 * (ADR-0011/0022 amendment).
 *
 * Before any aspect sub-agent fans out, the boss does one bounded web pass to
 * answer "which person is this, exactly?" — pinning the canonical public
 * profile (LinkedIn / company bio / personal site / GitHub) that matches the
 * name + work email. The resulting anchor is threaded into every aspect brief
 * so four parallel sub-agents all research the *same* person rather than four
 * different people who happen to share a name. Mismatch at this stage is the
 * expensive failure mode the design guards against — false matches are worse
 * than gaps.
 *
 * Bounded: a boss-tier model with a local `web_search` tool, capped at a few
 * searches via `stopWhen`. The final assistant text is the anchor — short prose
 * the aspects read verbatim, or an explicit "no confident match" when the
 * footprint is thin (consumer email, common name, nothing public). When there's
 * no confident match the downstream aspects stay conservative and the run still
 * completes cleanly with few or zero facts.
 */

const SEED_MAX_STEPS = 4;

export interface IdentityAnchor {
  /** ≤~150-word prose identity resolution, or an explicit no-confident-match. */
  anchor: string;
  /** Whether the boss found a profile it could confidently attribute. */
  confident: boolean;
  /** Citation URLs gathered during identity resolution. */
  citations: string[];
}

export interface ResolveIdentityArgs {
  signals: ColdStartSignals;
  runId?: string;
  stepId?: string;
  idempotencyKey?: string;
}

const SYSTEM_PROMPT = `You are the identity-resolution step of a personal AI assistant's self-onboarding research. The user is setting up the assistant for themselves and wants it to start from their own public footprint. Your single job: figure out *which specific person* the name + email below refers to, using the live web.

How to work:
- Run focused web searches that pair the name with a distinguishing detail (work email domain, likely employer, city, or a handle you discover) to separate this person from others who share the name.
- Stop as soon as you can confidently pin a canonical public profile (LinkedIn, company bio, personal site, GitHub, conference bio), or as soon as it's clear no public profile confidently matches.

Then write a SHORT identity anchor (≤150 words) that downstream research will treat as ground truth:
- Who this person most likely is in one or two sentences (role, employer, location if public).
- The canonical profile URL(s) you'd use to disambiguate them.
- Begin the anchor with "CONFIDENT:" if you found a profile you can confidently attribute, or "NO CONFIDENT MATCH:" if the name is too common, the footprint is too thin, or candidates can't be told apart. When unsure, prefer NO CONFIDENT MATCH — a false anchor poisons every downstream step.

Ground rules:
- Public sources only. Do not report contact details (home address, personal phone, email address, exact birthdate) — not even the email you were given.
- A consumer email domain (gmail.com, outlook.com, …) is NOT the person's employer — never treat it as a company.
- No preamble or meta-commentary. Output only the anchor.`;

function buildPrompt(signals: ColdStartSignals): string {
  const lines: string[] = [];
  lines.push(`Resolve the identity of this person:`);
  lines.push(`- Name: ${signals.name}`);
  lines.push(`- Primary email: ${signals.email}`);
  if (signals.emailDomain) {
    lines.push(
      `- Email domain: ${signals.emailDomain}${
        signals.emailDomainIsConsumer
          ? " (consumer mail provider — NOT an employer)"
          : " (likely a work domain — probably their employer)"
      }`,
    );
  }
  if (signals.integrations.google) {
    lines.push(`- Connected Google account: ${signals.integrations.google.accountEmail}`);
  }
  return lines.join("\n");
}

export async function resolveIdentity(args: ResolveIdentityArgs): Promise<IdentityAnchor> {
  const web = buildColdStartWebTool({
    userId: args.signals.userId,
    runId: args.runId,
    stepId: args.stepId ?? "seed",
  });

  const result = await meteredGenerateText(
    {
      model: getBossModel(),
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(args.signals),
      tools: web.tools,
      stopWhen: stepCountIs(SEED_MAX_STEPS),
      maxOutputTokens: 1_000,
      temperature: 0,
    },
    {
      kind: "llm",
      userId: args.signals.userId,
      runId: args.runId,
      stepId: args.stepId,
      idempotencyKey: args.idempotencyKey,
      requestMeta: { purpose: "cold-start.seed" },
      name: "cold-start.seed",
    },
  );

  const anchor = result.text.trim();
  return {
    anchor,
    confident: /^confident:/i.test(anchor),
    citations: web.citations,
  };
}
