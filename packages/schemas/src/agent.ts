import { EVENT_SOURCES } from "@alfred/contracts";
import { z } from "zod";

export const runStatusSchema = z.enum([
  "pending",
  "runnable",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export const RUN_STATUSES = Object.freeze([...runStatusSchema.options]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export function isTerminalStatus(s: RunStatus): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

export const approvalKindSchema = z.enum(["step", "action_staging"]);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

export const wakeConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hil"),
    approvalId: z.string(),
    approvalKind: approvalKindSchema.optional(),
    prompt: z.string().optional(),
  }),
  z.object({ kind: z.literal("timer"), wakeAt: z.string() }),
  z.object({ kind: z.literal("signal"), name: z.string() }),
]);
export type WakeCondition = z.infer<typeof wakeConditionSchema>;

export const agentRunTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    scheduledFor: z.string(),
  }),
  z.object({
    kind: z.literal("event"),
    // Optional for tolerant reads of historical event runs written before
    // ADR-0047 promoted source/type to first-class trigger fields.
    source: z.string().optional(),
    type: z.string().optional(),
    eventId: z.string(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("on_signal"), signalName: z.string() }),
]);
export type AgentRunTrigger = z.infer<typeof agentRunTriggerSchema>;

export const workflowTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    schedule: z.string(),
    timezone: z.string().optional(),
  }),
  z.object({
    kind: z.literal("event"),
    // Closed enums per ADR-0047; `type` is required on writes so the
    // `emitEvent` query (`trigger->>'source' = … AND trigger->>'type' = …`)
    // can match. Per-source type validity is enforced in `emitEvent`.
    source: z.enum(EVENT_SOURCES),
    type: z.string(),
    filter: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("on_signal"), name: z.string() }),
]);
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;

export const workflowStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run_skill"),
    id: z.string(),
    skillSlug: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("tool_call"),
    id: z.string(),
    tool: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("llm_call"),
    id: z.string(),
    prompt: z.string(),
    model: z.string().optional(),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("agent_run"),
    id: z.string(),
    workflowSlug: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("condition"),
    id: z.string(),
    expr: z.string(),
    onTrue: z.string(),
    onFalse: z.string(),
  }),
  z.object({
    kind: z.literal("parallel"),
    id: z.string(),
    branches: z.array(z.string()),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("loop"),
    id: z.string(),
    over: z.string(),
    body: z.string(),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("hil_approve"),
    id: z.string(),
    prompt: z.string().optional(),
    next: z.string().optional(),
  }),
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowStepsSchema = z.array(workflowStepSchema);
export type WorkflowSteps = z.infer<typeof workflowStepsSchema>;

export const workflowHilGatesSchema = z.array(z.string());
export type WorkflowHilGates = z.infer<typeof workflowHilGatesSchema>;
