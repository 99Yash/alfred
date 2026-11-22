export interface BackForwardCacheHandlers {
  /** The page may go into the back/forward cache. Release long-lived connections here. */
  onEnter: () => void;
  /** The page came back from the back/forward cache. Open the connections again. */
  onRestore: () => void;
}

/**
 * Run `onEnter` when the page goes into the back/forward cache (bfcache), and `onRestore` when it
 * comes back. Returns the unsubscribe.
 *
 * A cached page keeps its open `EventSource` until data arrives on it. Over HTTP/1.1 the browser
 * allows six connections for each host. So a few cached pages with open streams can fill them,
 * and a new request then waits until a heartbeat evicts a cached page.
 */
export function subscribeToBackForwardCache(handlers: BackForwardCacheHandlers): () => void {
  const onPageHide = (event: PageTransitionEvent) => {
    // `persisted: false` means the page unloads, and the browser closes its connections itself.
    if (event.persisted) handlers.onEnter();
  };

  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) handlers.onRestore();
  };

  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);

  return () => {
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
  };
}
