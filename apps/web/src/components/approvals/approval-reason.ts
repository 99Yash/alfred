import { assertNever, INTEGRATION_DISPLAY_NAMES, type ApprovalReason } from "@alfred/contracts";

/**
 * Why a card waits, from the reason that dispatch stored on the row (ADR-0130 amendment (c)). The
 * line never infers the reason from the tier. It names the setting that supplied the mode, the
 * global default too. `null`: a forced card, or a row from before the reason.
 */
export function approvalReasonLine(reason: ApprovalReason | null): string {
  if (reason === null) return "Review the details before it runs.";

  if (reason.cause === "high_risk") return "A high-risk action always asks first.";

  return `${modeSourceLine(reason)} ${causeLine(reason.cause)}`;
}

type GatedReason = Exclude<ApprovalReason, { cause: "high_risk" }>;

function modeSourceLine(reason: GatedReason): string {
  switch (reason.source) {
    case "tool_override":
      return "This action is set to ask first.";
    case "server_tool":
      return "This server tool is set to ask first.";
    case "integration":
      return `${INTEGRATION_DISPLAY_NAMES[reason.integration]} is set to ask first.`;
    case "default":
      return "Your default is to ask first.";
    default:
      return assertNever(reason.source, "approval mode source");
  }
}

function causeLine(cause: GatedReason["cause"]): string {
  switch (cause) {
    case "may_write":
      return "This call can change data.";
    case "secret_read":
      return "This read can show a secret.";
    case "unclassified_read":
      return "This read has no class yet.";
    default:
      return assertNever(cause, "approval cause");
  }
}
