CREATE TABLE "skill_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_run_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"agent_run_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"produced_revision_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"current_revision_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"last_invoked_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger" jsonb DEFAULT '{"kind":"manual"}'::jsonb NOT NULL,
	"brief" text,
	"steps" jsonb,
	"hil_gates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_integrations" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"last_run_id" text,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT current_timestamp
);
--> statement-breakpoint
ALTER TABLE "skill_revisions" ADD CONSTRAINT "skill_revisions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_revisions" ADD CONSTRAINT "skill_revisions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_revisions_skill_idx" ON "skill_revisions" USING btree ("skill_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_revisions_user_idx" ON "skill_revisions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_runs_skill_idx" ON "skill_runs" USING btree ("skill_id","started_at");--> statement-breakpoint
CREATE INDEX "skill_runs_user_kind_idx" ON "skill_runs" USING btree ("user_id","kind","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_runs_agent_run_idx" ON "skill_runs" USING btree ("agent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_slug_idx" ON "skills" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "skills_user_status_idx" ON "skills" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_slug_idx" ON "workflows" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "workflows_user_status_idx" ON "workflows" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "workflows_active_idx" ON "workflows" USING btree ("user_id","slug") WHERE "workflows"."status" = 'active';