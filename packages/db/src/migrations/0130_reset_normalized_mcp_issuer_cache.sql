-- Drop the cached authorization-server metadata whose issuer Alfred rewrote,
-- and put the connection that failed on it back in front of the consent screen.
--
-- `parseAuthorizationServerMetadata` used to return `new URL(parsed.issuer).href`.
-- That appends a path `/` to an origin-only issuer, and RFC 8414 §2 and RFC 9207
-- §2.4 both compare an issuer by SIMPLE STRING COMPARISON, so the stored copy can
-- never equal the `iss` an authorization server echoes. Every built-in publishes
-- the origin-only form, so every cached document carries the rewritten value.
--
-- Only Sentry sets `authorization_response_iss_parameter_supported`, so only
-- Sentry sends `iss` back and only Sentry ever reached the comparison. It
-- expected 'https://mcp.sentry.dev/' and received 'https://mcp.sentry.dev', and
-- the callback failed with the authorization code already in hand.
--
-- The code fix alone does not reach these rows. `authInternal` REUSES
-- `discoveryState.authorizationServerMetadata` whenever it is present, and
-- re-saves only when the object identity changes, so a cached document is never
-- re-fetched and the rewritten issuer survives every reconnect. NULLing the cache
-- is what forces the next authorize to re-discover and store the raw value.
-- Nothing is lost: the column caches a document the server serves on request.
--
-- The sealed tokens stay, so a connection that already works keeps working. The
-- catalog pointer stays too: no resource moved here, so the published tools are
-- still the right tools and dropping them would remove working tools for nothing.
--
-- The connection reset is narrower than the cache reset, on purpose. Every row
-- carries the rewritten cache, but only a row that actually FAILED this check may
-- be moved to `auth_required` — a healthy row must not be asked for a consent it
-- does not need. The predicate names the error text because `last_error` is the
-- only record of which check failed.
--
-- Idempotent: after one run no cached issuer has the rewritten shape and no
-- connection carries the message, so a second run reports UPDATE 0 for both.
UPDATE "mcp_oauth_credentials"
SET
	"discovery_state" = NULL,
	"updated_at" = now()
WHERE "discovery_state" -> 'authorizationServerMetadata' ->> 'issuer' ~ '^https://[^/]+/$';--> statement-breakpoint
UPDATE "mcp_connections"
SET
	"status" = 'auth_required',
	"last_error" = 'Additional permissions require your consent.',
	"updated_at" = now()
WHERE "status" = 'failed'
	AND "last_error" LIKE '%Issuer mismatch in authorization response (RFC 9207)%';
