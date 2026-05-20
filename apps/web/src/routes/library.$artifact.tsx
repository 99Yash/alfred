import * as RadixDialog from "@radix-ui/react-dialog";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Download, Maximize2, Share2, X } from "lucide-react";
import { ArtifactPageFrame } from "~/components/artifact-page-frame";
import { Button } from "~/components/ui/button";
import { getArtifact } from "~/lib/library-artifacts";

export const Route = createFileRoute("/library/$artifact")({
  component: ArtifactViewer,
});

function ArtifactViewer() {
  const { artifact: artifactId } = Route.useParams();
  const navigate = useNavigate();
  const artifact = getArtifact(artifactId);

  const close = () => {
    void navigate({ to: "/library" });
  };

  if (!artifact) {
    return (
      <RadixDialog.Root open onOpenChange={(open) => !open && close()}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm" />
          <RadixDialog.Content
            className="fixed inset-0 z-50 grid place-items-center p-4 focus:outline-none"
            aria-describedby={undefined}
          >
            <RadixDialog.Title className="sr-only">Artifact not found</RadixDialog.Title>
            <div className="rounded-3xl border border-white/[0.08] bg-[#101010] p-6 text-center shadow-pop">
              <p className="text-sm font-medium text-gray-950">Artifact not found</p>
              <Link
                to="/library"
                className="mt-3 inline-flex text-[12.5px] text-gray-800 underline underline-offset-4 hover:text-gray-1000"
              >
                Back to Library
              </Link>
            </div>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    );
  }

  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && close()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/86 backdrop-blur-sm" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col bg-transparent focus:outline-none"
        >
          <header className="flex min-h-[65px] items-center justify-between gap-4 border-b border-white/[0.08] px-4 sm:px-6">
            <div className="min-w-0">
              <RadixDialog.Title className="truncate text-sm font-medium text-gray-1000">
                {artifact.title}
              </RadixDialog.Title>
              <p className="mt-0.5 text-[12px] text-gray-800">
                Last modified: {artifact.updatedLabel}
              </p>
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
              <RadixDialog.Close asChild>
                <Link
                  to="/library"
                  aria-label="Close artifact"
                  className="grid h-8 w-8 place-items-center rounded-full bg-white/[0.05] text-gray-800 transition-colors hover:bg-white/[0.08] hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                >
                  <X size={15} />
                </Link>
              </RadixDialog.Close>
            </div>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
            <div className="mx-auto flex w-full max-w-[460px] flex-col gap-8">
              {artifact.pages.map((page, index) => (
                <section key={index} aria-label={`Page ${index + 1}`}>
                  <div className="mb-2 flex items-center justify-between text-[12px] text-gray-800">
                    <span>Page</span>
                    <span>
                      {index + 1} / {artifact.pages.length}
                    </span>
                  </div>
                  {page.html ? (
                    <ArtifactPageFrame
                      html={page.html}
                      title={`${artifact.title} page ${index + 1}`}
                    />
                  ) : (
                    <div className="min-h-[590px] rounded-xl bg-[#ededed] p-10 text-black shadow-2xl">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-black/45">
                        {page.kicker}
                      </p>
                      <h2 className="mt-6 text-3xl font-semibold leading-tight">{page.title}</h2>
                      <p className="mt-6 text-[15px] leading-7 text-black/68">{page.body}</p>
                    </div>
                  )}
                </section>
              ))}
            </div>
          </main>

          <div className="pointer-events-none fixed bottom-4 right-5 text-[12px] text-gray-700">
            Esc to exit
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
