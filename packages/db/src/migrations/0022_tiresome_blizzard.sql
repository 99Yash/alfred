ALTER TABLE "briefings" ALTER COLUMN "gather" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "briefings" ALTER COLUMN "breaking_summary" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "briefings" ALTER COLUMN "breaking_summary" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "briefings" ALTER COLUMN "full_briefing" DROP NOT NULL;