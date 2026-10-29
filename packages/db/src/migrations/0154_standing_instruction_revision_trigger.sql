-- ADR-0113 decision 3 (plan decision 13). Each write to a standing-instruction row in
-- "user_facts" raises the per-user instruction-set revision in the same transaction. The
-- trigger is the one owner, so a new writer, a script, or hand SQL cannot leave a stale
-- revision. A stored triage match that read an older revision then reads as unknown.
-- The EXISTS guard skips a user that a cascade delete removes in the same command.
CREATE OR REPLACE FUNCTION user_facts_raise_instruction_set_revision() RETURNS TRIGGER AS $$
DECLARE
  uid text;
BEGIN
  -- Only a change to what a reader sees counts. A bookkeeping update leaves stored matches current.
  IF TG_OP = 'UPDATE'
     AND (OLD.user_id, OLD.key, OLD.value, OLD.status, OLD.valid_from, OLD.valid_until)
         IS NOT DISTINCT FROM
         (NEW.user_id, NEW.key, NEW.value, NEW.status, NEW.valid_from, NEW.valid_until) THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.key = 'standing_instruction' THEN
    uid := OLD.user_id;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.key = 'standing_instruction' THEN
    uid := NEW.user_id;
  END IF;
  IF uid IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO "standing_instruction_set_revisions" ("user_id", "revision")
  SELECT uid, 1
  WHERE EXISTS (SELECT 1 FROM "user" WHERE "id" = uid)
  ON CONFLICT ("user_id") DO UPDATE
    SET "revision" = "standing_instruction_set_revisions"."revision" + 1,
        "updated_at" = now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER user_facts_instruction_set_revision
AFTER INSERT OR UPDATE OR DELETE ON "user_facts"
FOR EACH ROW EXECUTE FUNCTION user_facts_raise_instruction_set_revision();
