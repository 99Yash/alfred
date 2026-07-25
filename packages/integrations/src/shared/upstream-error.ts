import { httpErrorFromResponse, summarizeBody, type ErrorBodyPolicy } from "@alfred/contracts";

/**
 * The one non-2xx branch every provider transport shares: turn a failed
 * `Response` into an {@link HttpError} under the provider's
 * {@link ErrorBodyPolicy}, and — for `"omit"` — leave the bounded, redacted body
 * behind in the server log before dropping it from the error.
 *
 * It exists so `bodyPolicy` is reachable from EVERY transport rather than from
 * whichever one happened to implement it. `authedJson` had the `"omit"` logging
 * inline; `defineProviderClient` had no way to express the policy at all, so a
 * provider whose body must not travel (Notion) could not move onto the shared
 * client. One owner for the branch closes that gap and keeps the log line's shape
 * identical across transports.
 *
 * Lives in `integrations/` rather than `@alfred/contracts` because the `"omit"`
 * half does I/O (a log write); the contracts factory stays browser-safe and pure.
 */
export async function throwUpstreamError(args: {
  provider: string;
  res: Response;
  /** Redacted URL label the error reports — never the token-bearing request URL. */
  url: string;
  method?: string;
  bodyPolicy?: ErrorBodyPolicy;
}): Promise<never> {
  const { provider, res, url, method, bodyPolicy } = args;
  // `"omit"` drops the body from the error (which flows on into telemetry), so
  // this is the last place that still has it: log the bounded, redacted slice for
  // server-side debugging. The read spends the stream, which is why the log has
  // to happen here and not at the call site.
  if (bodyPolicy === "omit") {
    const raw = await res.text().catch(() => "");
    console.error(`[${provider}] ${res.status} ${method ?? "GET"} ${url} :: ${summarizeBody(raw)}`);
  }
  // Safe after the read above: `"omit"` discards the body either way, so the
  // spent stream cannot change the resulting error.
  throw await httpErrorFromResponse(provider, res, { url, method, bodyPolicy });
}
