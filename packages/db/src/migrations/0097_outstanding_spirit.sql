DROP INDEX "integration_object_relations_object_idx";--> statement-breakpoint
DROP INDEX "integration_objects_kind_idx";--> statement-breakpoint
DROP INDEX "integration_credentials_user_idx";--> statement-breakpoint
DROP INDEX "rejected_inferences_key_idx";--> statement-breakpoint
DROP INDEX "model_prices_lookup_idx";--> statement-breakpoint
CREATE INDEX "pending_actions_run_idx" ON "pending_actions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "chat_messages_run_idx" ON "chat_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "documents_embed_sweep_idx" ON "documents" USING btree ("ingested_at" DESC NULLS LAST) WHERE "documents"."embed_failed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "memory_chunks_embed_sweep_idx" ON "memory_chunks" USING btree ("id") WHERE "memory_chunks"."embedding" IS NULL AND "memory_chunks"."embed_failed_at" IS NULL;