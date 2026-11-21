import type { EffectiveAuthor, SignificanceBand } from "@alfred/contracts";
import type { UserSettings } from "@alfred/assistant/settings";
import { logger } from "@alfred/logging";
import { readSenderPerson } from "../knowledge";
import { resolveSenderKind, triageSenderKindProjectionEnabled } from "./sender-kind";

export type SenderSignificanceBucket = SignificanceBand | "unscored";

export function isColdContactFromSignals(args: {
  inbound: number;
  outbound: number;
  bucket: SenderSignificanceBucket;
}): boolean {
  const twoWay = args.inbound > 0 && args.outbound > 0;

  return !twoWay && (args.outbound === 0 || args.bucket === "weak");
}

/**
 * The proactive draft gate still reads the old triage snapshot (ADR-0098).
 * Keep its existing decision until the owner settles draft eligibility.
 */
export async function readLegacyDraftColdSender(args: {
  userId: string;
  settings: UserSettings;
  senderAddress: string | null;
  effectiveAuthor: EffectiveAuthor;
}): Promise<boolean> {
  if (args.effectiveAuthor !== "person" || args.senderAddress === null) return false;

  const [sender, projectionEnabled] = await Promise.all([
    readSenderPerson(args.userId, args.senderAddress),
    triageSenderKindProjectionEnabled(args.settings).catch((err: unknown) => {
      logger.warn({ err, userId: args.userId }, "[triage] draft sender-kind flag read failed");

      return false;
    }),
  ]);

  if (projectionEnabled && (await resolveSenderKind(args.userId, args.senderAddress)) !== null) {
    return false;
  }

  if (sender.kind !== "found") return sender.kind === "none";

  const { inbound = 0, outbound = 0 } = sender.metadata.correspondence ?? {};

  return isColdContactFromSignals({
    inbound,
    outbound,
    bucket: sender.significance?.band ?? "unscored",
  });
}
