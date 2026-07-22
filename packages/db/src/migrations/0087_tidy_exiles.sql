ALTER TABLE "mcp_invocation" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "mcp_invocation" ADD COLUMN "step_id" text;--> statement-breakpoint
ALTER TABLE "mcp_invocation" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
ALTER TABLE "mcp_invocation" ADD COLUMN "delivery_possible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_invocation" ADD COLUMN "response_received_at" timestamp with time zone;