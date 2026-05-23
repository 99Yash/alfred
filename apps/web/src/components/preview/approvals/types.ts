/**
 * Shared types for the /preview/approvals surface. Lives here so the per-
 * component files (approval-card, input-preview, etc.) can pull from a
 * single source without re-declaring the union literals.
 */

export type RiskTier = "low" | "medium" | "high";
export type ToolName = "gmail.send_draft" | "calendar.create_event";

export interface LocalApproval {
  id: string;
  toolName: ToolName;
  workflowSlug: string;
  runId: string;
  integration: string;
  riskTier: RiskTier;
  proposedInput: Record<string, unknown>;
  recentRejection?: { decidedAt: string; reason: string };
  createdAt: string;
}
