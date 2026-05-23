import { Link, useNavigate } from "@tanstack/react-router";
import { Download, Maximize2, Share2, X } from "lucide-react";
import { useCallback, useEffect } from "react";
import { ArtifactPageFrame } from "~/components/artifact-page-frame";
import { VsButton } from "~/components/ui/visitors";
import { getArtifact } from "~/lib/library-artifacts";
import { cn } from "~/lib/utils";
import { Route } from "~/routes/preview.library.$artifact";

export function PreviewArtifactViewer() {
  const { artifact: artifactId } = Route.useParams();
  const navigate = useNavigate();
  const artifact = getArtifact(artifactId);

  const close = useCallback(() => {
    void navigate({ to: "/preview/library" });
  }, [navigate]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [close]);

  if (!artifact) {
    return (
      <dialog
        open
        aria-modal="true"
        aria-label="Artifact not found"
        className="fixed inset-0 z-[60] m-0 flex max-h-none max-w-none items-center justify-center border-0 bg-transparent p-0 vs-fade-in"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={close}
          className="absolute inset-0 bg-vs-background/70 backdrop-blur-[2px]"
        />
        <div
          className={cn(
            "relative w-[min(420px,92vw)] rounded-2xl bg-vs-bg-1 p-6 text-center",
            "shadow-[0_24px_64px_rgba(0,0,0,0.20),0_0_0_1px_rgba(0,0,0,0.06)]",
          )}
        >
          <p className="text-sm font-medium text-vs-fg-4">Artifact not found</p>
          <Link
            to="/preview/library"
            className="mt-3 inline-flex text-xs text-vs-fg-3 underline underline-offset-4 hover:text-vs-fg-4"
          >
            Back to Library
          </Link>
        </div>
      </dialog>
    );
  }

  return (
    <dialog
      open
      aria-modal="true"
      aria-label={artifact.title}
      className="fixed inset-0 z-[60] m-0 flex max-h-none max-w-none flex-col border-0 bg-transparent p-0 vs-fade-in"
    >
      <button
        type="button"
        aria-label="Close artifact"
        onClick={close}
        className="absolute inset-0 -z-10 bg-vs-background/88 backdrop-blur-[6px]"
      />

      <header
        className={cn(
          "relative flex min-h-[60px] items-center justify-between gap-4 px-4 sm:px-6",
          "shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)]",
        )}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-vs-fg-4">{artifact.title}</p>
          <p className="mt-0.5 text-[11.5px] text-vs-fg-3">
            Last modified: {artifact.updatedLabel}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <VsButton variant="ghost" size="md" aria-label="Share artifact">
            <Share2 size={15} />
          </VsButton>
          <VsButton variant="ghost" size="md" aria-label="Download artifact">
            <Download size={15} />
          </VsButton>
          <VsButton variant="ghost" size="md" aria-label="Fullscreen artifact">
            <Maximize2 size={15} />
          </VsButton>
          <Link
            to="/preview/library"
            aria-label="Close artifact"
            className={cn(
              "grid size-8 place-items-center rounded-full bg-vs-bg-2 text-vs-fg-3",
              "transition-colors hover:bg-vs-bg-3 hover:text-vs-fg-4",
              "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
            )}
          >
            <X size={15} />
          </Link>
        </div>
      </header>

      <main className="relative min-h-0 flex-1 overflow-y-auto vs-scrollbar px-4 py-8">
        <div className="mx-auto flex w-full max-w-[460px] flex-col gap-8">
          {artifact.pages.map((page, index) => (
            <section key={`${page.title}-${index}`} aria-label={`Page ${index + 1}`}>
              <div className="mb-2 flex items-center justify-between text-[11.5px] text-vs-fg-3">
                <span>Page</span>
                <span className="tabular-nums">
                  {index + 1} / {artifact.pages.length}
                </span>
              </div>
              {page.html ? (
                <ArtifactPageFrame
                  html={page.html}
                  title={`${artifact.title} page ${index + 1}`}
                />
              ) : (
                <div
                  className={cn(
                    "min-h-[590px] rounded-2xl bg-vs-bg-1 p-10 text-vs-fg-4",
                    "shadow-[0_8px_24px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.06)]",
                  )}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-vs-fg-2">
                    {page.kicker}
                  </p>
                  <h2 className="mt-6 text-3xl font-semibold leading-tight text-vs-fg-4">
                    {page.title}
                  </h2>
                  <p className="mt-6 text-[15px] leading-7 text-vs-fg-3">{page.body}</p>
                </div>
              )}
            </section>
          ))}
        </div>
      </main>

      <div className="pointer-events-none absolute bottom-4 right-5 text-[11.5px] text-vs-fg-2">
        Esc to exit
      </div>
    </dialog>
  );
}
