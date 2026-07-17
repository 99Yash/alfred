import { Globe2 } from "lucide-react";
import { useState } from "react";
import { faviconFor } from "~/lib/favicon";
import { cn } from "~/lib/utils";

/**
 * A site favicon in a small rounded chip, with a graceful fallback. The
 * DuckDuckGo CDN (see {@link faviconFor}) returns a transparent image rather
 * than 404ing for unknown domains, so most misses render as a blank chip; the
 * `onError` path additionally swaps in a neutral globe when the request truly
 * fails (offline, blocked), so a browsing card never shows a broken image.
 *
 * Shared by the tool-call cards (the site Alfred is reading) and the web-search
 * result list; the standalone {@link SourcesStrip} keeps its own bespoke chip.
 */
export function Favicon({
  domain,
  size = 16,
  className,
}: {
  domain: string;
  size?: number;
  className?: string;
}) {
  // Re-attempt the load when the domain changes (a card can be reused for a
  // different URL as a streaming run reissues), clearing a prior failure. This
  // resets during render off a prev-prop comparison rather than in an effect,
  // so the stale failure never flashes for a frame after the domain swaps.
  const [failed, setFailed] = useState(false);
  const [prevDomain, setPrevDomain] = useState(domain);
  if (domain !== prevDomain) {
    setPrevDomain(domain);
    setFailed(false);
  }

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-[4px] bg-app-bg-2 ring-1 ring-white/10 ring-inset",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {failed ? (
        <Globe2 size={Math.round(size * 0.72)} className="text-app-fg-3" aria-hidden />
      ) : (
        <img
          src={faviconFor(domain)}
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
