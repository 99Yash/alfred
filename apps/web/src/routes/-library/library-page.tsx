import { AlertTriangle, Loader2, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { AppButton, AppInput } from "~/components/ui/v2";
import { useRecentArtifacts } from "~/lib/replicache/use-artifacts";
import { cn } from "~/lib/utils";
import { ArtifactCard } from "./artifact-card";
import { artifactMatchesQuery, artifactMatchesType, type ArtifactType } from "./helpers";
import { LibraryEmpty } from "./library-empty";
import { TypeFilterPopover } from "./type-filter-popover";

export function LibraryPage({ dimmed = false }: { dimmed?: boolean }) {
  const { artifacts: recentArtifacts, loading, error, retry } = useRecentArtifacts();
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<Set<ArtifactType>>(new Set());
  const hasCachedArtifacts = recentArtifacts.length > 0;

  const artifacts = useMemo(() => {
    return recentArtifacts.filter((artifact) => {
      if (!artifactMatchesType(artifact, types)) return false;
      return artifactMatchesQuery(artifact, query);
    });
  }, [query, recentArtifacts, types]);

  return (
    <div
      className={cn(
        "scroll-stable min-w-0 flex-1 overflow-y-auto transition-opacity",
        dimmed && "pointer-events-none opacity-35 select-none",
      )}
    >
      <main className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <header className="app-card-in space-y-3 text-center">
          <h1 className="text-[40px] leading-[48px] font-medium tracking-tight text-app-fg-4">
            Recent artifacts
          </h1>
          <p className="text-sm text-app-fg-3">Your latest documents and generated pages.</p>
        </header>

        <div
          className="app-card-in mt-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          style={{ animationDelay: "100ms" }}
        >
          <TypeFilterPopover selectedTypes={types} onSelectedTypesChange={setTypes} />
          <div className="relative w-full sm:w-[300px]">
            <Search
              size={14}
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-app-fg-2"
            />
            <AppInput
              placeholder="Search artifacts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search artifacts"
              className="!h-9 pl-9"
            />
          </div>
        </div>

        <div className="mt-10">
          {loading ? (
            <LibraryState
              icon={<Loader2 size={22} className="animate-spin" />}
              title="Loading artifacts"
            />
          ) : error && !hasCachedArtifacts ? (
            <LibraryState
              icon={<AlertTriangle size={22} />}
              title="Artifacts could not be loaded"
              description={error}
              action={<AppButton onClick={retry}>Try again</AppButton>}
            />
          ) : (
            <div className="space-y-4">
              {error ? (
                <div className="flex items-center justify-between gap-4 rounded-xl bg-app-bg-2 px-4 py-3">
                  <p className="text-xs text-app-fg-3">
                    Showing cached artifacts. <span className="text-app-red-4">{error}</span>
                  </p>
                  <AppButton size="sm" onClick={retry}>
                    Retry
                  </AppButton>
                </div>
              ) : null}
              {artifacts.length > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {artifacts.map((artifact, i) => (
                    <ArtifactCard key={artifact.id} artifact={artifact} index={i} />
                  ))}
                </div>
              ) : (
                <LibraryEmpty query={query} />
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function LibraryState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid min-h-[280px] place-items-center text-center">
      <div className="flex max-w-md flex-col items-center">
        <span className="text-app-fg-3">{icon}</span>
        <p className="mt-3 text-sm font-medium text-app-fg-4">{title}</p>
        {description ? <p className="mt-1 text-xs text-app-fg-3">{description}</p> : null}
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}
