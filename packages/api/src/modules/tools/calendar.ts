/**
 * Calendar tools — registered to lock in the registry shape and the
 * Phase 3 dispatcher's medium-risk gating path. The Google Calendar
 * client itself lands later in m13; both executes throw a clear
 * "pending" error so an early Phase 3 dispatch loop produces a
 * recoverable failure on the staging row rather than silent success.
 */

import { z } from "zod";
import { liveTool, type RegisteredTool } from "./registry";

const calendarListEventsInput = z
  .object({
    timeMin: z.string().datetime().optional(),
    timeMax: z.string().datetime().optional(),
    maxResults: z.number().int().min(1).max(50).default(10),
  })
  .strict();

const calendarCreateEventInput = z
  .object({
    summary: z.string().min(1).max(500),
    description: z.string().max(10_000).optional(),
    start: z.string().datetime(),
    end: z.string().datetime(),
    attendees: z.array(z.string().email()).max(50).optional(),
  })
  .strict();

const PENDING = "google calendar client lands later in m13";

export const calendarTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "calendar",
    action: "list_events",
    riskTier: "no_risk",
    description: "List Google Calendar events in an optional time window.",
    inputSchema: calendarListEventsInput,
    execute: async () => {
      throw new Error(`calendar.list_events execute pending: ${PENDING}`);
    },
  }),
  liveTool({
    integration: "calendar",
    action: "create_event",
    riskTier: "medium",
    description: "Create a Google Calendar event after the user approves the details.",
    inputSchema: calendarCreateEventInput,
    execute: async () => {
      throw new Error(`calendar.create_event execute pending: ${PENDING}`);
    },
  }),
];
