CREATE INDEX IF NOT EXISTS "agent_runs_deferred_idx" ON "agent_runs" USING btree ("deferred_until") WHERE "agent_runs"."status" = 'deferred';
