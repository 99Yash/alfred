import { z } from "zod";

/**
 * Chat model escalation tiers. The single source of truth for the tier
 * literal, shared so the web bundle can reference it without pulling in
 * `@alfred/ai` (Node-only). `@alfred/ai`'s `getChatModel` maps each tier to a
 * concrete model; see `provider.ts`.
 *
 *   - `standard` — the default conversational driver.
 *   - `deep`     — escalation for hard, multi-step turns.
 */
export const chatModelTierValues = ["standard", "deep"] as const;
export type ChatModelTier = (typeof chatModelTierValues)[number];
export const chatModelTierSchema = z.enum(chatModelTierValues);
