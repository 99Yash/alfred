import { z } from "zod";

/**
 * Chat model tier — the user-selectable depth for a chat turn. The single
 * source of truth for the tier literal, shared so the web bundle can reference
 * it without pulling in `@alfred/ai` (Node-only): the composer's tier picker
 * and the send-message hook both previously hand-declared the same literal.
 * `@alfred/ai`'s `getChatModel` maps each tier to a concrete model; see
 * `provider.ts`.
 *
 *   - `standard` — the default conversational driver (the fast everyday model).
 *   - `deep`     — escalation for hard, multi-step turns.
 */
export const chatModelTierValues = ["standard", "deep"] as const;
export type ChatModelTier = (typeof chatModelTierValues)[number];
export const chatModelTierSchema = z.enum(chatModelTierValues);
