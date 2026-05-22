/**
 * Gmail tools registered into the boss's tool surface.
 *
 * Phase 2 ships the registration + an executable `gmail.search` so the
 * autonomy path can be smoke-tested end-to-end. `gmail.send_draft`
 * registers at boot but throws on execute until the Phase 4 agent
 * bridge wires the Gmail send API — the dispatcher only invokes
 * `execute` on the approved-staging resume path for gated tools, so a
 * stubbed execute is safe to ship now and harden later.
 */

import { getFreshAccessToken, listCredentials, listMessages } from "@alfred/integrations/google";
import { z } from "zod";
import { liveTool, type RegisteredTool } from "./registry";

const gmailSearchInput = z
  .object({
    q: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Gmail search query. Supports the full Gmail operator set (in:, from:, newer_than:, has:, …).",
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Cap on results returned to the model (Gmail allows up to 500; we cap at 50)."),
  })
  .strict();

const gmailSendDraftInput = z
  .object({
    to: z.array(z.string().email()).min(1).max(25),
    cc: z.array(z.string().email()).max(25).optional(),
    bcc: z.array(z.string().email()).max(25).optional(),
    subject: z.string().min(1).max(1000),
    bodyText: z.string().min(1).max(50_000),
    /**
     * Optional `In-Reply-To` / `References` thread anchor — the dispatcher
     * surfaces this on the approval card so the user can confirm what
     * thread Alfred is replying into.
     */
    threadId: z.string().optional(),
  })
  .strict();

async function pickGoogleCredentialId(userId: string): Promise<string> {
  const creds = await listCredentials(userId, "google");
  const active = creds.find((c) => c.status === "active");
  if (!active) {
    throw new Error(
      `[gmail.tools] user ${userId} has no active google credential — reconnect in settings`,
    );
  }
  return active.id;
}

export const gmailTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "gmail",
    action: "search",
    riskTier: "no_risk",
    inputSchema: gmailSearchInput,
    execute: async (input, ctx) => {
      const credentialId = await pickGoogleCredentialId(ctx.userId);
      const accessToken = await getFreshAccessToken(credentialId);
      const result = await listMessages({
        accessToken,
        q: input.q,
        maxResults: input.maxResults,
      });
      return {
        messages: result.messages.map((m) => ({ id: m.id, threadId: m.threadId })),
        nextPageToken: result.nextPageToken ?? null,
      };
    },
  }),
  liveTool({
    integration: "gmail",
    action: "send_draft",
    riskTier: "high",
    inputSchema: gmailSendDraftInput,
    execute: async () => {
      // Wiring lands in Phase 4 alongside the agent bridge. Until then,
      // the dispatcher can stage a gated row and the registry resolves —
      // an approval that reaches execute surfaces this error to the
      // staging row's execute_error, which is the correct "ship a
      // half-implemented tool" failure mode.
      throw new Error("gmail.send_draft execute lands with m13 phase 4 (agent bridge)");
    },
  }),
];
