import { httpErrorFromResponse, summarizeBody, type ErrorBodyPolicy } from "@alfred/contracts";

/**
 * Shared non-2xx branch: throw an {@link HttpError} under the body policy. For `"omit"`,
 * log the bounded body first. Not in `@alfred/contracts` because the log is I/O.
 */
export async function throwUpstreamError(args: {
  provider: string;
  res: Response;
  /** Never the token-bearing URL. */
  url: string;
  method?: string | undefined;
  bodyPolicy?: ErrorBodyPolicy | undefined;
}): Promise<never> {
  const { provider, res, url, method, bodyPolicy } = args;

  // The last place that still has the body. Reading it spends the stream.
  if (bodyPolicy === "omit") {
    const raw = await res.text().catch(() => "");
    console.error(`[${provider}] ${res.status} ${method ?? "GET"} ${url} :: ${summarizeBody(raw)}`);
  }

  // Safe: `"omit"` discards the body anyway.
  throw await httpErrorFromResponse(provider, res, { url, method, bodyPolicy });
}
