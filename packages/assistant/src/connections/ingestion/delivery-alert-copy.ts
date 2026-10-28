/**
 * The words of one alert email (ADR-0100 amendment 2026-10-28, revised). The code supplies the
 * connection's facts; a low-cost model writes the headline and the body, as the user's assistant
 * would. The template adds the button and the link.
 */

import { meteredGenerateObject, route } from "@alfred/ai";
import { DEFAULT_VOICE_PROMPT, sanitizeVoice } from "@alfred/ai/voice";
import { logger } from "@alfred/logging";
import { z } from "zod";
import {
  BROKEN_CONNECTION_GUIDANCE,
  describeBrokenConnection,
  type BrokenConnection,
} from "../broken-connection-facts";

const COPY_TIMEOUT_MS = 20_000;

const alertCopySchema = z.object({
  headline: z.string().min(1).max(120),
  body: z.string().max(1_500),
});

export type DeliveryAlertCopy = z.infer<typeof alertCopySchema>;

const ALERT_COPY_INSTRUCTIONS = [
  BROKEN_CONNECTION_GUIDANCE,
  "Write one short email. Return `headline` (it is also the subject; under 80 characters; state the cost, not `connection broken`) and `body` (one or two short paragraphs, separated by a blank line).",
  DEFAULT_VOICE_PROMPT,
].join("\n\n");

/**
 * The model's words for one alert. On a model failure, a bare headline and no body: the email
 * still goes out with its button, because a silent alert is the failure this surface exists for.
 */
export async function composeDeliveryAlertCopy(
  userId: string,
  connection: BrokenConnection,
): Promise<DeliveryAlertCopy> {
  try {
    const result = await meteredGenerateObject(
      {
        model: route("cheap").model(),
        schema: alertCopySchema,
        schemaName: "delivery_alert_copy",
        instructions: ALERT_COPY_INSTRUCTIONS,
        prompt: describeBrokenConnection(connection),
        temperature: 0.3,
        maxOutputTokens: 600,
        timeout: COPY_TIMEOUT_MS,
      },
      { kind: "llm", userId, name: "delivery-alert.copy" },
    );

    return {
      headline: sanitizeVoice(result.output.headline),
      body: sanitizeVoice(result.output.body),
    };
  } catch (err) {
    logger.warn(
      { err },
      `[delivery-alert] copy failed for user=${userId} key=${connection.key}; sending a bare alert`,
    );

    return { headline: `Reconnect ${connection.name}`, body: "" };
  }
}
