ALTER TABLE "briefings" ADD COLUMN "closed_loops" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Existing GitHub object rows already retain the canonical PR URL even though
-- the reducer used to mint only a head_sha sidecar key. Backfill the new key so
-- notification-email reconciliation works immediately after deploy, without
-- waiting for another webhook delivery or a receipt replay.
INSERT INTO "integration_object_keys" (
	"id",
	"user_id",
	"object_id",
	"provider",
	"key_kind",
	"key_value"
)
SELECT
	'iobjk_' || substr(md5(o."user_id" || ':' || o."id" || ':pull_request_url'), 1, 12),
	o."user_id",
	o."id",
	'github',
	'pull_request_url',
	'https://github.com/' || lower(parts[1]) || '/pull/' || (parts[2]::bigint)::text
FROM "integration_objects" o
CROSS JOIN LATERAL regexp_match(
	o."url",
	'^https?://github\.com/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/pull/([0-9]+)(?:[/?#].*)?$',
	'i'
) AS parts
WHERE o."provider" = 'github'
	AND o."kind" = 'pull_request'
	AND o."url" IS NOT NULL
	AND parts[1] IS NOT NULL
	AND parts[2] IS NOT NULL
	AND parts[2]::numeric BETWEEN 1 AND 9007199254740991
ON CONFLICT ("user_id", "provider", "key_kind", "key_value")
DO UPDATE SET "object_id" = EXCLUDED."object_id";
