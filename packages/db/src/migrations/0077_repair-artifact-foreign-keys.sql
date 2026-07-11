-- A local db:push/partial apply created artifacts without migration 0068's
-- foreign keys. Remove rows that cannot have a valid required owner/thread and
-- clear dangling optional provenance before restoring the constraints.
DELETE FROM "artifacts" a
WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u."id" = a."user_id")
   OR NOT EXISTS (SELECT 1 FROM "chat_threads" t WHERE t."id" = a."thread_id");
--> statement-breakpoint
UPDATE "artifacts" a SET "run_id" = NULL
WHERE "run_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "agent_runs" r WHERE r."id" = a."run_id");
--> statement-breakpoint
UPDATE "artifacts" a SET "message_id" = NULL
WHERE "message_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "chat_messages" m WHERE m."id" = a."message_id");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_user_id_user_id_fk' AND conrelid = 'public.artifacts'::regclass) THEN
    ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_thread_id_chat_threads_id_fk' AND conrelid = 'public.artifacts'::regclass) THEN
    ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_run_id_agent_runs_id_fk' AND conrelid = 'public.artifacts'::regclass) THEN
    ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_message_id_chat_messages_id_fk' AND conrelid = 'public.artifacts'::regclass) THEN
    ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
