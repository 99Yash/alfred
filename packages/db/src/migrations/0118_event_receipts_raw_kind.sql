-- #988 / ADR-0097 item 9: the raw receipt tier. A verified, owner-attributed
-- inbound delivery whose kind the event registry does not name is stored with
-- raw_kind = the provider's own kind, event_type = '<source>.raw', and
-- provider_delivery_id = payload_hash. NULL raw_kind is the typed tier.
ALTER TABLE "event_receipts" ADD COLUMN "raw_kind" text;
