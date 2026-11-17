-- The nine labels (ADR-0121; triage-theory-v1 slice 2). A rename of stored values, not a
-- new triage run: `action_needed` -> `action`, `awaiting_reply` and `follow_up` -> `reply`,
-- `payment` -> `receipt`, `newsletter` -> `news`, `marketing` -> `promo`. The live history
-- tables (`email_triage_changes`, `agent_decision_traces`, run states) keep their old
-- values: history is never rewritten.
--
-- The old CHECK constraints leave first: a mapped value (`news`) violates them, and the
-- mapped values must land before the new CHECK constraints arrive.
ALTER TABLE "sender_priors" DROP CONSTRAINT "sender_priors_last_category_valid";--> statement-breakpoint
ALTER TABLE "email_triage" DROP CONSTRAINT "email_triage_category_valid";--> statement-breakpoint

UPDATE "email_triage" SET "category" = CASE "category"
  WHEN 'action_needed' THEN 'action'
  WHEN 'awaiting_reply' THEN 'reply'
  WHEN 'follow_up' THEN 'reply'
  WHEN 'payment' THEN 'receipt'
  WHEN 'newsletter' THEN 'news'
  WHEN 'marketing' THEN 'promo'
  ELSE "category" END
WHERE "category" IN ('action_needed', 'awaiting_reply', 'follow_up', 'payment', 'newsletter', 'marketing');--> statement-breakpoint
UPDATE "email_triage"
SET "model_verdict" = jsonb_set("model_verdict", '{category}', to_jsonb(CASE "model_verdict"->>'category'
  WHEN 'action_needed' THEN 'action'
  WHEN 'awaiting_reply' THEN 'reply'
  WHEN 'follow_up' THEN 'reply'
  WHEN 'payment' THEN 'receipt'
  WHEN 'newsletter' THEN 'news'
  WHEN 'marketing' THEN 'promo'
  ELSE "model_verdict"->>'category' END))
WHERE "model_verdict" ? 'category';--> statement-breakpoint
-- The standing instructions carry `force_category` effects, so a live instruction with an
-- old id must map, or its parse fails and the instruction goes dark.
DO $$
DECLARE
  r RECORD;
  effects JSONB;
  effect JSONB;
  mapped JSONB;
  i INT;
BEGIN
  FOR r IN SELECT id, value FROM user_facts WHERE value ? 'effects' LOOP
    effects := r.value->'effects';
    FOR i IN 0 .. jsonb_array_length(effects) - 1 LOOP
      effect := effects->i;
      IF effect ? 'category' THEN
        mapped := jsonb_set(effect, '{category}', to_jsonb(CASE effect->>'category'
          WHEN 'action_needed' THEN 'action'
          WHEN 'awaiting_reply' THEN 'reply'
          WHEN 'follow_up' THEN 'reply'
          WHEN 'payment' THEN 'receipt'
          WHEN 'newsletter' THEN 'news'
          WHEN 'marketing' THEN 'promo'
          ELSE effect->>'category' END));
        effects := jsonb_set(effects, ARRAY[i::text], mapped);
      END IF;
    END LOOP;
    UPDATE user_facts SET value = jsonb_set(r.value, '{effects}', effects) WHERE id = r.id;
  END LOOP;
END
$$;--> statement-breakpoint
-- `sender_priors` has no reader since slice 1 stopped the self-learning; its row still
-- carries the category CHECK, so the stored last category maps.
UPDATE "sender_priors" SET "last_category" = CASE "last_category"
  WHEN 'action_needed' THEN 'action'
  WHEN 'awaiting_reply' THEN 'reply'
  WHEN 'follow_up' THEN 'reply'
  WHEN 'payment' THEN 'receipt'
  WHEN 'newsletter' THEN 'news'
  WHEN 'marketing' THEN 'promo'
  ELSE "last_category" END
WHERE "last_category" IN ('action_needed', 'awaiting_reply', 'follow_up', 'payment', 'newsletter', 'marketing');--> statement-breakpoint
ALTER TABLE "sender_priors" ADD CONSTRAINT "sender_priors_last_category_valid" CHECK ("sender_priors"."last_category" IN ('action', 'done', 'fyi', 'meeting', 'news', 'promo', 'receipt', 'reply', 'urgent'));--> statement-breakpoint
ALTER TABLE "email_triage" ADD CONSTRAINT "email_triage_category_valid" CHECK ("email_triage"."category" IN ('action', 'done', 'fyi', 'meeting', 'news', 'promo', 'receipt', 'reply', 'urgent'));
