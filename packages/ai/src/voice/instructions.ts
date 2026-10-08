import { DEFAULT_VOICE_PROMPT } from "./prompt";

export const AGENT_OUTPUT_PURPOSES = {
  assistant_response: { voice: "default" },
  audience_content: { voice: "default" },
  source_faithful: { voice: "none" },
  internal: { voice: "none" },
} as const satisfies Record<string, { voice: VoicePolicy }>;

type AgentOutputPurpose = keyof typeof AGENT_OUTPUT_PURPOSES;

export type VoicePolicy = "default" | "none";

export interface ComposeAgentInstructionsArgs {
  /** Picks the default voice. */
  purpose: AgentOutputPurpose;
  /** Always the first block. */
  role: string;
  rules?: readonly string[];
  /** Rare override of the purpose's voice. */
  voice?: VoicePolicy;
  /** Per-run text. Last, so the stable prefix stays cached. */
  grounding?: readonly string[];
}

export function composeAgentInstructions(args: ComposeAgentInstructionsArgs): string {
  const voice = args.voice ?? AGENT_OUTPUT_PURPOSES[args.purpose].voice;
  const blocks = [args.role, ...(args.rules ?? [])];

  if (voice === "default") blocks.push(DEFAULT_VOICE_PROMPT);
  blocks.push(...(args.grounding ?? []));

  return blocks.filter((block) => block.length > 0).join("\n\n");
}
