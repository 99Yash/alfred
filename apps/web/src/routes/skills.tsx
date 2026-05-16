import { IDB_KEY, type SyncedSkill } from "@alfred/sync";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { ReadTransaction } from "replicache";
import { authClient } from "~/lib/auth-client";
import { client, edenErrorMessage } from "~/lib/eden";
import { useSubscribe } from "~/lib/replicache/hooks";
import { SkillStatusPill } from "~/lib/skills-ui";

export const Route = createFileRoute("/skills")({
  component: SkillsPage,
});

const listSkills = async (tx: ReadTransaction): Promise<SyncedSkill[]> => {
  const entries = await tx.scan({ prefix: IDB_KEY.SKILL({}) }).entries().toArray();
  return entries.map(([, v]) => v as unknown as SyncedSkill);
};

function SkillsPage() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const skills = useSubscribe(listSkills);

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCreate = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await client.api.skills.post({
        name: name.trim(),
        prompt: prompt.trim(),
      });
      if (res.error) {
        setError(edenErrorMessage(res.error, "Failed to create skill"));
        return;
      }
      setName("");
      setPrompt("");
      await navigate({ to: "/skills/$slug", params: { slug: res.data.slug } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setCreating(false);
    }
  };

  if (!session?.user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-muted-foreground">Not signed in.</p>
          <a href="/login" className="underline text-sm">
            Sign in
          </a>
        </div>
      </div>
    );
  }

  const sorted = [...(skills ?? [])].sort((a, b) =>
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
  );

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-bold">Skills</h1>

      <section className="rounded-md border p-4 space-y-3">
        <h2 className="text-lg font-semibold">New skill</h2>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. Job search 2026)"
          className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
          maxLength={200}
        />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should alfred remember about this? (this prompt + your memory drive the first version of the body)"
          className="w-full rounded-md border px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-primary min-h-[120px]"
          maxLength={8_000}
        />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex justify-end">
          <button
            onClick={onCreate}
            disabled={creating || !name.trim() || !prompt.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {creating ? "Creating…" : "Learn"}
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Your skills{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({sorted.length})
          </span>
        </h2>
        {skills === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You haven't authored any skills yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {sorted.map((skill) => (
              <li key={skill.id}>
                <a
                  href={`/skills/${skill.slug}`}
                  className="block rounded-md border px-4 py-3 text-sm hover:bg-accent"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{skill.name}</span>
                    <SkillStatusPill status={skill.status} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground font-mono">
                    /{skill.slug}
                  </p>
                  {skill.description ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {skill.description}
                    </p>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

