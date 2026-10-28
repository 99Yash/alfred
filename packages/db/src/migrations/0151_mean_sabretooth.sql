ALTER TABLE "todos" DROP CONSTRAINT "todos_resolved_by_valid";--> statement-breakpoint
ALTER TABLE "todos" DROP COLUMN "resolved_by";--> statement-breakpoint
ALTER TABLE "todos" DROP COLUMN "resolved_reason";