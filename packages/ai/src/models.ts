export interface ModelCapabilities {
  minContextWindow?: number;
  supportsToolCalls?: boolean;
  costTier: "cheap" | "mid" | "expensive";
}

export interface ModelDescriptor {
  id: string;
  provider: "anthropic" | "google" | "openai";
  name: string;
  capabilities: ModelCapabilities;
}

export const MODEL_REGISTRY: ModelDescriptor[] = [
  {
    id: "claude-opus-4-7",
    provider: "anthropic",
    name: "Claude Opus 4.7",
    capabilities: { costTier: "expensive", supportsToolCalls: true, minContextWindow: 200000 },
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    name: "Claude Sonnet 4.6",
    capabilities: { costTier: "mid", supportsToolCalls: true, minContextWindow: 200000 },
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    name: "Claude Haiku 4.5",
    capabilities: { costTier: "cheap", supportsToolCalls: true, minContextWindow: 200000 },
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    name: "Gemini 2.5 Pro",
    capabilities: { costTier: "expensive", supportsToolCalls: true, minContextWindow: 1000000 },
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    name: "Gemini 2.5 Flash",
    capabilities: { costTier: "cheap", supportsToolCalls: true, minContextWindow: 1000000 },
  },
];
