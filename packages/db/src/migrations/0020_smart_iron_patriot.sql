-- email_triage: switch from per-document PK to per-thread PK.
-- Each Gmail thread now gets one row; new messages in the thread re-run
-- classify and overwrite. See packages/db/src/schema/triage.ts header.

-- 1. Add new column nullable for backfill.
ALTER TABLE "email_triage" ADD COLUMN "source_thread_id" text;--> statement-breakpoint

-- 2. Backfill source_thread_id from the joined documents row.
UPDATE "email_triage" et
SET source_thread_id = d.source_thread_id
FROM "documents" d
WHERE d.id = et.document_id;--> statement-breakpoint

-- 3. Drop rows we couldn't attribute to a thread (orphan docs / non-gmail).
DELETE FROM "email_triage" WHERE source_thread_id IS NULL;--> statement-breakpoint

-- 4. Dedup: keep the latest message's classification per
--    (user_id, source_thread_id). "Latest" = newest Gmail authored_at,
--    falling back to classified_at if the document pointer is dangling.
DELETE FROM "email_triage" et
USING (
  SELECT et2.ctid,
         ROW_NUMBER() OVER (
           PARTITION BY et2.user_id, et2.source_thread_id
           ORDER BY COALESCE(d.authored_at, et2.classified_at) DESC,
                    et2.classified_at DESC
         ) AS rn
  FROM "email_triage" et2
  LEFT JOIN "documents" d ON d.id = et2.document_id
) ranked
WHERE et.ctid = ranked.ctid AND ranked.rn > 1;--> statement-breakpoint

-- 5. Drop old constraints. document_id stops being a hard FK / PK position.
ALTER TABLE "email_triage" DROP CONSTRAINT "email_triage_document_id_documents_id_fk";--> statement-breakpoint
ALTER TABLE "email_triage" DROP CONSTRAINT "email_triage_pkey";--> statement-breakpoint
ALTER TABLE "email_triage" ALTER COLUMN "document_id" DROP NOT NULL;--> statement-breakpoint

-- 6. Lock in new shape.
ALTER TABLE "email_triage" ALTER COLUMN "source_thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "email_triage" ADD CONSTRAINT "email_triage_user_id_source_thread_id_pk" PRIMARY KEY("user_id","source_thread_id");
