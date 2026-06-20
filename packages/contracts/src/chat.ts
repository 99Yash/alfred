import { z } from "zod";

/**
 * Chat model tier — the user-selectable depth for a chat turn. The server maps
 * it through `getChatModel` (standard → the fast everyday model, deep → the
 * deeper-reasoning escalation).
 *
 * Canonical here so the three places that need it share one source of truth:
 * the server's `@alfred/ai` `ChatModelTier`, and the web bundle (which can't
 * import `@alfred/ai` — Node-only) where the composer's tier picker and the
 * send-message hook both previously hand-declared the same literal.
 */
export const chatModelTierValues = ["standard", "deep"] as const;
export type ChatModelTier = (typeof chatModelTierValues)[number];
export const chatModelTierSchema = z.enum(chatModelTierValues);
