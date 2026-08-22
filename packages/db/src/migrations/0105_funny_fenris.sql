-- Content dedup for gmail_attachment documents: the same unchanged file
-- arriving under N different `messageId:attachmentId` source ids keeps ONE
-- corpus row (the oldest), and later occurrences are recorded as
-- `metadata.references` on it. Collapse any duplicates that already exist so
-- the unique index below cannot fail on live data.
DELETE FROM "documents"
WHERE "source" = 'gmail_attachment'
  AND "id" NOT IN (
    SELECT DISTINCT ON ("user_id", "content_hash") "id"
    FROM "documents"
    WHERE "source" = 'gmail_attachment'
    ORDER BY "user_id", "content_hash", "ingested_at" ASC, "id" ASC
  );
CREATE UNIQUE INDEX "documents_attachment_content_hash_idx" ON "documents" USING btree ("user_id","source","content_hash") WHERE "documents"."source" = 'gmail_attachment';
