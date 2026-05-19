import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Download, Maximize2, Share2, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "~/components/ui/button";
import { getArtifact } from "~/lib/library-artifacts";

export const Route = createFileRoute("/library/$artifact")({
  component: ArtifactViewer,
});

function ArtifactViewer() {
  const { artifact: artifactId } = Route.useParams();
  const navigate = useNavigate();
  const artifact = getArtifact(artifactId);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void navigate({ to: "/library" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  if (!artifact) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4">
        <div className="rounded-3xl border border-white/[0.08] bg-[#101010] p-6 text-center shadow-pop">
          <p className="text-sm font-medium text-gray-950">Artifact not found</p>
          <Link
            to="/library"
            className="mt-3 inline-flex text-[12.5px] text-gray-800 underline underline-offset-4 hover:text-gray-1000"
          >
            Back to Library
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="artifact-viewer-title"
      className="fixed inset-0 z-50 flex flex-col bg-black/86 backdrop-blur-sm"
    >
      <header className="flex min-h-[65px] items-center justify-between gap-4 border-b border-white/[0.08] px-4 sm:px-6">
        <div className="min-w-0">
          <h1 id="artifact-viewer-title" className="truncate text-sm font-medium text-gray-1000">
            {artifact.title}
          </h1>
          <p className="mt-0.5 text-[12px] text-gray-800">Last modified: {artifact.updatedLabel}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="md" aria-label="Share artifact">
            <Share2 size={15} />
          </Button>
          <Button variant="ghost" size="md" aria-label="Download artifact">
            <Download size={15} />
          </Button>
          <Button variant="ghost" size="md" aria-label="Fullscreen artifact">
            <Maximize2 size={15} />
          </Button>
          <Link
            to="/library"
            aria-label="Close artifact"
            className="grid h-8 w-8 place-items-center rounded-full bg-white/[0.05] text-gray-800 transition-colors hover:bg-white/[0.08] hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
          >
            <X size={15} />
          </Link>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <div className="mx-auto flex w-full max-w-[460px] flex-col gap-8">
          {artifact.pages.map((page, index) => (
            <section key={`${page.title}-${index}`} aria-label={`Page ${index + 1}`}>
              <div className="mb-2 flex items-center justify-between text-[12px] text-gray-800">
                <span>Page</span>
                <span>
                  {index + 1} / {artifact.pages.length}
                </span>
              </div>
              <div className="min-h-[590px] rounded-xl bg-[#ededed] p-10 text-black shadow-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-black/45">
                  {page.kicker}
                </p>
                <h2 className="mt-6 text-3xl font-semibold leading-tight">{page.title}</h2>
                <p className="mt-6 text-[15px] leading-7 text-black/68">{page.body}</p>
              </div>
            </section>
          ))}
        </div>
      </main>

      <div className="pointer-events-none fixed bottom-4 right-5 text-[12px] text-gray-700">
        Esc to exit
      </div>
    </div>
  );
}
