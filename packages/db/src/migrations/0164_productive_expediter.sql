-- The index was applied manually on prod ahead of this migration (CREATE INDEX
-- IF NOT EXISTS keeps both orders working); the schema source in
-- `packages/db/src/schema/integrations.ts` owns its definition.
CREATE INDEX IF NOT EXISTS "event_receipts_provider_delivered_idx" ON "event_receipts" USING btree ("provider","delivered_at");