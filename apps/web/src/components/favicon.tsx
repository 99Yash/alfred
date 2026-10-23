import { Globe2 } from "lucide-react";
import { useState } from "react";
import { faviconFor } from "~/lib/favicon";
import { cn } from "~/lib/utils";

/**
 * A site favicon chip. DuckDuckGo ({@link faviconFor}) returns a blank image for unknown domains.
 * A real load failure shows a globe.
 */
export function Favicon({
  domain,
  size = 16,
  className,
}: {
  domain: string;
  size?: number | undefined;
  className?: string | undefined;
}) {
  // A card can get a new domain mid-run. Reset the failure during render, so it does not flash.
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
