// The Railway deployment config as one Alchemy program (ADR-0128).
//
// The real project is a lookup, never managed: `alchemy destroy` cannot
// delete it. The two app services are managed — the first
// `pnpm --filter @alfred/infra adopt` (`alchemy deploy --adopt`) takes them
// over in place, no duplicate: the apply-time ownership probe finds the
// dashboard-created service and feeds its attributes into the update (gate
// evidence: docs/research/alchemy-railway-probe.md). Until that deploy, a
// plain `alchemy plan` previews `Server` and `Web` as tentative creates — the
// plan-time probe is deferred because the project reference is unresolved at
// plan time. The `VerifyDatabases` action is the part a plan proves: it
// resolves the database lookups, so a missing database fails the plan.
//
// This slice does not change the deploy trigger: both services keep their
// GitHub repo source, so Railway still builds on push (ADR-0128 D2 gates the
// trigger switch on the deployed-commit re-source).
import * as Alchemy from "alchemy";
import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import { Alfred } from "./src/project.ts";
import { Db, Cache, DbVolume, CacheVolume } from "./src/databases.ts";
import { Server, Web } from "./src/services.ts";

export default Alchemy.Stack(
  "Alfred",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const server = yield* Server;
    const web = yield* Web;

    // The action's inputs read the database lookups, so every `alchemy plan`
    // resolves them (a missing database fails with `LookupNotFoundError`
    // before any deploy). The body is pure: it restates what the plan proved.
    const databases = yield* Alchemy.Action(
      "VerifyDatabases",
      (input: {
        dbImage: string | undefined;
        cacheHost: string;
        dbVolumeMount: string;
        cacheVolumeMount: string;
      }) => Effect.succeed(input),
    )({
      dbImage: Db.image,
      cacheHost: Cache.privateHost,
      dbVolumeMount: DbVolume.mountPath,
      cacheVolumeMount: CacheVolume.mountPath,
    });

    // Stack output: non-secret attributes only — outputs print to the
    // terminal without redaction.
    return {
      project: Alfred.name,
      serverId: server.serviceId,
      webId: web.serviceId,
      dbImage: databases.dbImage,
      cacheHost: databases.cacheHost,
      dbVolumeMount: databases.dbVolumeMount,
      cacheVolumeMount: databases.cacheVolumeMount,
    };
  }),
);
