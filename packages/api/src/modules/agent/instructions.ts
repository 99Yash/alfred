import { DEFAULT_VOICE_PROMPT } from "./voice.js";

export const AGENT_OUTPUT_PURPOSES = {
  assistant_response: { voice: "default" },
  audience_content: { voice: "default" },
  source_faithful: { voice: "none" },
  internal: { voice: "none" },
} as const satisfies Record<string, { voice: VoicePolicy }>;

export type AgentOutputPurpose = keyof typeof AGENT_OUTPUT_PURPOSES;
export type VoicePolicy = "default" | "none";

export interface ComposeAgentInstructionsArgs {
  /** Required semantic classification; its closed policy map supplies the voice default. */
  purpose: AgentOutputPurpose;
  /** Role and mission. This is always the first, cache-stable block. */
  role: string;
  /** Additional cache-stable capability or behavior blocks. */
  rules?: readonly string[];
  /** Rare typed override. Audience-specific prose stays in validated request context. */
  voice?: VoicePolicy;
  /** Per-run grounding, ordered last so stable prompt prefixes remain cacheable. */
  grounding?: readonly string[];
}

/** Compose a system prompt with one centrally-owned output-voice decision. */
export function composeAgentInstructions(args: ComposeAgentInstructionsArgs): string {
  const voice = args.voice ?? AGENT_OUTPUT_PURPOSES[args.purpose].voice;
  const blocks = [args.role, ...(args.rules ?? [])];

  if (voice === "default") blocks.push(DEFAULT_VOICE_PROMPT);
  blocks.push(...(args.grounding ?? []));

  return blocks.filter((block) => block.length > 0).join("\n\n");
}
