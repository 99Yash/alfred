# Alchemy `@alchemy.run/railway` — switching the deploy trigger to context upload or prebuilt image — 2026-11-18

Research for the ADR-0128 cutover: the two app Services today use `repo:` + `branch:` (RAILPACK builder, GitHub-push trigger). The plan is to move the trigger to Alchemy-side context upload or a prebuilt image. This doc answers six questions against primary sources: the Alchemy docs (https://alchemy.run) and the installed provider source.

**Version researched:** `alchemy` and `@alchemy.run/railway` both **2.0.0-beta.87**, pinned together with `effect` in the pnpm catalog (`pnpm-workspace.yaml:33,93,103`; installed `package.json` under `infra/node_modules/@alchemy.run/railway/`). All source citations are `infra/node_modules/@alchemy.run/railway/src/*` at that pin. Docs quotes are from `alchemy.run` (page text fetched 2026-11-18) and `docs.railway.com/llms-full.txt` (fetched 2026-11-18).

## Q1. The `context:` prop — source, upload, builder, Dockerfile, image, registry

### What `context` accepts

`context` is a **local directory path**, not a glob. `Service.ts:57-62`:

```ts
/**
 * Local Docker context uploaded with Railway `up`. Paths are relative to the
 * initial working directory. Limited to a 32 MiB archive, 10,000 entries,
 * ASCII paths, and no symlinks; Docker ignore files apply.
 */
context?: string;
```

Enforcement is in `local-context.ts`:

- The path must exist and be a directory; symlinks are rejected (`local-context.ts:132-147`, error `ServiceContextPathInvalid` / `ServiceContextSymlinkUnsupported`).
- The path is resolved against the **initial cwd** (`local-context.ts:124`, `path.resolve(initialCwd, source.context)`) — not against the program file.
- Tar size cap 32 MiB (`MAX_CONTEXT_BYTES`, `local-context.ts:13`), 10,000 entries (`:14`), ASCII-only paths (`:237`), no symlinks anywhere in the tree (`:240-241`).
- **Docker ignore files apply** before the tar is built: `resolveBuild` calls `selectDockerBuildContext` from `@alchemy.run/docker/BuildHash`, which reads `Dockerfile.dockerignore` then `.dockerignore` in the context root (`@alchemy.run/docker/src/BuildHash.ts:74-103`). The tar contains only the included entries (`local-context.ts:217-256`).

### What the provider does with it

The source resolution rules (`local-context.ts:59-119`) define exactly one source per Service, picked from `main`, `context`, `image`, `repo`:

```ts
if (modes.length === 0) → ServiceImageOrMainRequired("`image`, `main`, `context`, or `repo`")
if (modes.length !== 1) → ServiceSourceInvalid(
  "...exactly one source: `main`, `context`, `image`, or `repo`
   (`image` may configure the base image for `main`).")
```

So `context` is **mutually exclusive** with `image` and `repo` (`Service.ts:375-377` says the same). At reconcile the provider (`ServiceProvider.ts:1102-1104`) calls `prepareRailwayLocalContext`, which copies the selected entries into a temp snapshot, tar-gzips it, and returns `{ codeHash, dockerfilePath, tarball }` (`local-context.ts:282-313`). The upload is `Up.ts:59-101`:

- `POST {apiBaseUrl}/project/{projectId}/environment/{environmentId}/up?serviceId={serviceId}&message={message}` with the gzipped tar as the body (`Up.ts:39-53,76-77`).
- Auth: bearer token, or `Project-Access-Token` header for project tokens (`Up.ts:79-82`).
- The response gives `deploymentId`, `url`, `logsUrl`, `deploymentDomain` (`Up.ts:18-23`). Railway then builds and deploys; the provider polls that deployment id (`ServiceProvider.ts:1345-1358`).

The module comment states the contract plainly (`Up.ts:1-5`): "POST a gzipped Docker context to backboard `/project/:id/environment/:id/up`. Railway builds the generated Dockerfile; Alchemy never pushes an image" — i.e. the same pipeline as `railway up`.

### Interaction with `builder`

`builder` is a separate service-instance setting, applied through `serviceInstanceUpdate` regardless of source mode (`ServiceProvider.ts:371`, `365`; prop at `Service.ts:219-222`). The type mirrors Railway's API: `"HEROKU" | "NIXPACKS" | "PAKETO" | "RAILPACK"` (`@distilled.cloud/railway/lib/graphql.d.ts:366`) — there is no `DOCKERFILE` builder value; Railway detects a Dockerfile automatically. The provider does **not** set `builder` when you pass `context`; Railway's own builder selection decides. Railway's docs describe the pipeline behavior: "Committing a Dockerfile also switches your service to the Dockerfile builder on the next deploy, even if it previously built with Railpack" (https://docs.railway.com/builds, `RAILWAY_DOCKERFILE_PATH` section). That statement is about config-as-code commits, not uploaded contexts — **unverified** whether the same auto-switch happens for a context upload containing a Dockerfile; it is the same build pipeline as `railway up`, so it likely does.

### `dockerfilePath`

Yes — a `dockerfilePath` prop exists (`Service.ts:213-218`): "Dockerfile path relative to `rootDirectory`, or to `context` for a local context. @default 'Dockerfile'". For a context upload it is validated hard (`local-context.ts:125-176`): non-empty, relative (no leading `/`), must exist inside the context, and no path segment may be a symlink; the validated path is written to the instance via `serviceInstanceUpdate.dockerfilePath` (`ServiceProvider.ts:1206-1212`, `364-370`). Railway also accepts `RAILWAY_DOCKERFILE_PATH` as a service variable for the same purpose (see Q2/Q3).

### `image` — prebuilt image deploy

Yes — pass `image` **without** `main`. `Service.ts:63-70`:

```ts
/**
 * Docker image Railway should run.
 *
 * When `main` is omitted this is `source.image` (e.g.
 * `hashicorp/http-echo`). When `main` is set this is the generated
 * Dockerfile's `FROM` (default `node:26-slim`).
 */
image?: string;
```

The image is written to the service source (`source.image`) and deployed with `serviceInstanceDeployV2` (`ServiceProvider.ts:273-284`, `1105-1106`; docs page https://alchemy.run/railway/compute/services, "For an image Service, Alchemy sets `source.image` and deploys with `serviceInstanceDeployV2`"). Image equality tolerates `:latest` and registry-prefix variants (`ServiceProvider.ts:202-209`). Any image ref Railway can pull works (public registry refs; the probe doc already verified `ghcr.io/railwayapp-templates/postgres-ssl:18` and `redis:8.2.9` images live in the alfred project).

### `registry` — credentials for a private registry

**No `registry:` prop exists in this version.** The plumbing is half-built: `instanceSettingsDelta` accepts `registryCredentials` and would write it (`ServiceProvider.ts:249, 286-289`), but reconcile passes a hard-coded `undefined` (`ServiceProvider.ts:1217-1218`). The Railway API does have the field — `registryCredentials?: RegistryCredentialsInput` on both `serviceCreate` and `serviceInstanceUpdate`, with `{ username, password }` and the schema comment "Private Docker registry credentials. Only available for Pro plan deployments." (`@distilled.cloud/railway/lib/graphql.d.ts:1060-1064, 1106, 1164`). So a private-registry image deploy would need either the API field (not exposed by the provider in beta.87) or a public image. **Silent in Alchemy docs.**

## Q2. Variables

Two mechanisms, both present:

### Service `env` prop

`env?: Record<string, any>` on ServiceProps (`Service.ts:92-97`): "Additional environment variables. Merged after binding-injected `env`. Upserted as service-scoped Railway variables with `skipDeploys: true`; this Service owns the subsequent deploy." The full env composition at reconcile (`ServiceProvider.ts:1064-1071`): binding env, then `ALCHEMY_STACK_NAME` / `ALCHEMY_STAGE` / `ALCHEMY_PHASE` / `HOST` (hosted.ts:712-717), then `PORT`, then `props.env`, then the RPC token. Each entry is upserted via `Railway.variableUpsert({ ... skipDeploys: true })` only when the observed value differs (`ServiceProvider.ts:685-699, 720-742`). Values unwrap `Redacted` (`hosted.ts:231-257`). An env change sets `needsDeploy`, so the provider deploys after upserting (`ServiceProvider.ts:1288-1294`).

The docs advise against `env` for secrets — yield `Config.Redacted` instead (https://alchemy.run/railway/compute/services, "Config": "Do not pass `env: { ... }` on a Service unless you are packing a known-plain value"). A deploy-time commit SHA is a known-plain value, so `env` fits.

### `Railway.Variable` resource

`Variable.ts:36-69` — `{ project, environment?, service?, name?, value }`. `service` scopes it to one service; omit it for a shared project variable. `name` is the env-var name, "Stored as-is when set by the user (case-sensitive)" (`Variable.ts:54-60`). `value` may be a plain string, a `Redacted` secret, or a `Railway.ref` template (`${{Db.DATABASE_URL}}`) that Railway interpolates (`Variable.ts:60-68`). Upsert also uses `skipDeploys: true` (`Variable.ts:367-381`); the Service resource owns deploys. Changing `project` / `environment` / `service` / `name` replaces the variable.

### Build-time availability

Railway injects service variables into the **build** environment as well as runtime. Primary-source statements:

- Builds page (https://docs.railway.com/builds): "Every variable you define, plus Railway-provided variables like `RAILWAY_ENVIRONMENT`, is available while your service builds" — with the split: "Railpack builds (Railway's default builder) expose variables to the build automatically. Dockerfile builds do not... you must opt in with an `ARG` instruction" (also at https://docs.railway.com/builds/dockerfiles#using-variables-at-build-time).
- Variables page: Railway-provided variables are provided "to all builds and deployments" (https://docs.railway.com/variables/reference).

So for a context-upload RAILPACK build, `env`/Variables set on the Service are visible to the build; with a Dockerfile in the context they are visible only through `ARG`. This also matches the alfred `web`/`server` build commands (`pnpm turbo run build …`) which read `TURBO_TEAM`-style env at build time today.

## Q3. Reserved `RAILWAY_*` variable names

**The current Railway docs are silent on a general rule.** Checks run:

- https://docs.railway.com/variables/reference (and `.app` mirror) lists Railway-provided variables, git variables, tracing variables, and "User-provided configuration variables" — six of which are `RAILWAY_`-prefixed (`RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`, `RAILWAY_DOCKERFILE_PATH`, `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, `RAILWAY_RUN_UID`, `RAILWAY_SHM_SIZE_BYTES`). No text forbids user-created `RAILWAY_*` variables.
- The Dockerfiles page **instructs users to set** a `RAILWAY_`-prefixed service variable: "In your service variables, set a variable named `RAILWAY_DOCKERFILE_PATH` to specify the path to the file" (https://docs.railway.com/builds/dockerfiles). That is primary-source evidence that at least some `RAILWAY_*` names can be user-set as service variables.
- The full docs text (`docs.railway.com/llms-full.txt`, 2.8 MB, fetched 2026-11-18) contains no rule about the `RAILWAY_` prefix anywhere (grepped `reserved`, `RAILWAY_ prefix`, `prefix RAILWAY`).
- An August 2024 archive of the old `docs.railway.app/reference/variables` page says only: "there is a notion of service variables, shared variables, reference variables, and a few kinds of reserved variables" (web.archive.org/web/20240814101708) — a category mention, no rule. The December 2023 snapshot is identical in this respect.

The dashboard-vs-API difference is **unverified**: third-party pages claim built-ins cannot be overridden from the dashboard, but neither the docs nor the API schema visible to us (`variableUpsert` input has only `projectId/environmentId/name/value/serviceId/skipDeploys`, `@distilled.cloud/railway/lib/graphql.d.ts`) documents a rejection for `RAILWAY_GIT_COMMIT_SHA`-style names. The provider adds no validation either — it passes the name through as-is (`Variable.ts:54-60`, `ServiceProvider.ts:685-699`). If a user-set `RAILWAY_*` variable is needed at cutover, it must be probed first; the ADR's fallback (neutral `ALFRED_*` names) remains the safe default. **Do not rely on it without an experiment.**

## Q4. Dockerfile base image

The Effect-native (`main`) image's `FROM` is in the provider source, not the Railway API: `hosted.ts:88`:

```ts
export const DEFAULT_BASE_IMAGE = "node:26-slim";
```

`generateDockerfile` emits `FROM ${props.image ?? DEFAULT_BASE_IMAGE}` and `ENTRYPOINT ["node", "/app/index.mjs"]` (`hosted.ts:659-696`). So **`image` overrides the base image for a `main` Service** (`Service.ts:63-70` documents this), and the generated image runs **Node**, not Bun (Bootstrap imports `@effect/platform-node` `NodeServices` and serves with a Node HTTP server, `railway/src/Bootstrap.ts:9-57`).

**The docs disagree with the source, and the source wins.** https://alchemy.run/railway/compute/services says `FROM oven/bun:1` (twice: "generates a Dockerfile (default `FROM oven/bun:1`)" and "Override the base image with `image` (must still run bun when `main` is set)"). The generated reference page agrees with the source: "generates a Dockerfile (`FROM node:26-slim`)" (https://alchemy.run/providers/railway/reference/service). The beta.87 code is unambiguous (`node:26-slim`, Node entrypoint). The "must still run bun" caveat is stale for this pin.

**For a `context:`-upload build there is no base-image knob in the provider.** `image` cannot be combined with `context` (`local-context.ts:83-99`, exactly-one-source rule). The base image of a Railpack build of the uploaded context is Railpack's own detection; Railway documents `RAILPACK_*` variables for packages/apt (`RAILPACK_PACKAGES`, `RAILPACK_BUILD_APT_PACKAGES`, `RAILPACK_DEPLOY_APT_PACKAGES`, https://docs.railway.com/builds, pointing to https://railpack.com/config/environment-variables) and config-as-code `railway.toml` in the source — **unverified** for the uploaded-context path, and not surfaced through the provider's props. With a Dockerfile in the context, the base image is whatever the Dockerfile says.

## Q5. The Effect-native `main` contract

Confirmed from source: `main` is for **Effect-native programs only**. The type is (`alchemy/src/Platform.ts`, `Main`):

```ts
export type Main<InitServices = never> = void | {
  fetch?: HttpEffect<...> | Effect.Effect<HttpEffect<...>, never, ...>;
};
```

Mechanics: the provider bundles `main` with Rolldown and wraps it in a shim that imports `@alchemy.run/railway/Bootstrap` plus the user's `main`, takes the **`default` export**, and calls `bootstrap(entrypoint)` (`hosted.ts:162-172`). `bootstrap` builds the entrypoint into an Effect layer, resolves the program (`{ fetch }` HTTP handler or `host.run` loops), and serves it on a Node HTTP server bound to `PORT` (`railway/src/Bootstrap.ts:25-57`; `alchemy/src/Runtime/Bootstrap.ts:48-90`). The class contract (constructor Effect returns `{ fetch }` or runs a `ServerHost` loop) is documented at https://alchemy.run/railway/compute/services ("Serve HTTP with `fetch`", "Background services").

A plain Bun/Node entrypoint does **not** fit: `entrypointLayer` expects an inline-effect class default export or an Effect layer (`alchemy/src/Runtime/Bootstrap.ts:42-49`); an Elysia instance or a bare `node dist/index.js` entry has no `{ fetch }` Effect and no registered `host.run` program. There is an internal `isExternal` mode that copies files verbatim (`hosted.ts:571-580, 673-682`), but it is marked `@internal` (`alchemy/src/Platform.ts:44-48`), is not a documented Service prop, and still boots through the Effect `bootstrap`. **Assumption stands: the Elysia server (`node apps/server/dist/index.js`) must use `context:` or `image:`, not `main:`** — same conclusion as the probe doc's sharp edge #4.

## Q6. Deploy mechanics for a context-upload deploy

### What triggers a redeploy

Only an `alchemy deploy` (or `plan`+`deploy` of the program) runs the reconcile that uploads. Per reconcile (`ServiceProvider.ts:1313-1372`), an upload happens when the source is `main` or `context` **and** one of:

1. the computed content hash differs from the recorded `code.hash` (diff: `ServiceProvider.ts:882-902`; for `context`, `hashRailwayLocalContext` hashes the docker-build inputs — context, Dockerfile path, `linux/amd64` platform — including ignore-file filtering, `local-context.ts:258-280`),
2. the latest deployment is not `SUCCESS`/`SLEEPING`, or
3. the service source changed (moving off `repo`/`image` onto `context` triggers `serviceDisconnect` and a deploy, `ServiceProvider.ts:1196-1204`; GitHub deployment triggers are deleted, `:1269-1279`).

No push hook exists on the Railway side anymore — with `repo:` removed there is no GitHub trigger; a redeploy happens only when someone runs `alchemy deploy` (CI in our case). Variable changes go through `serviceInstanceDeployV2` (`:1359-1372`).

### How the deployment is named and tracked

- **State attributes** carry `deploymentId`, `deploymentStatus`, and `code: { hash }` (`Service.ts:287-294`, `ServiceProvider.ts:845-847`).
- **Deploy message:** the upload URL takes a `message` query param (`Up.ts:49-51`), and the provider hard-codes it to `` `alchemy ${id} ${codeHash}` `` (`ServiceProvider.ts:1350`). This is the same knob as `railway up -m/--message` ("Message to attach to the deployment", https://docs.railway.com/cli/up) — visible as deployment metadata in the dashboard. (The workspace patch appends the unique attempt id to this message, and the deploy report matches it — ADR-0128, the 2026-11-27 amendment.)
- Upload returns `deploymentId/url/logsUrl/deploymentDomain` (`Up.ts:18-23`); the provider then polls that specific deployment (`matchUploadedDeployment`, `waitForDeploymentById`, `ServiceProvider.ts:572-676`).

### Commit-sha piggyback options

1. **`serviceInstanceDeployV2(commitSha)` exists in the Railway API** (`@distilled.cloud/railway/lib/graphql.d.ts:6164-6169`) and is documented: "To deploy a specific commit... pass `commitSha`... The `commitSha` is validated against the connected GitHub repo; an unknown SHA returns a 'Commit not found' error and no deployment is created" (https://docs.railway.com/reference/api, "Deploy a service"). The provider never passes it (`ServiceProvider.ts:776-778`). **Caveat:** validation is against the *connected repo* — once we switch to `context:`, the provider disconnects the repo source, so this path is most likely unusable. **Unverified.**
2. **Deploy message.** The provider's message is fixed (`alchemy ${id} ${codeHash}`); there is no prop to set it, so we cannot put `GITHUB_SHA` there without a provider change. A neutral env Variable set by CI before `alchemy deploy` (or an `env:` prop value computed in the program from `process.env.GITHUB_SHA`) is the provider-supported way.
3. **`RAILWAY_DEPLOYMENT_ID`** is a Railway-provided variable "to all builds and deployments" (https://docs.railway.com/variables/reference) — always present, unlike the git variables, which are "provided if the deploy originated from a GitHub trigger". The tracing docs confirm the split: `OTEL_SERVICE_VERSION` is "the commit SHA of the deployment, or the deployment ID for image and CLI deployments". This matches the probe result: on a context-upload deploy `RAILWAY_GIT_COMMIT_SHA` is absent and `RAILWAY_GIT_REPO_OWNER`/`NAME` are empty strings.

Nothing in the API or the provider maps an uploaded deploy to a commit. Any commit attribution must be our own variable (or a Sentry release), as the ADR fallback already says.

## Answers to the six questions

1. **`context:`** — a local **directory** path (relative to the initial cwd, no globs). The provider validates it (32 MiB tar, 10k entries, ASCII paths, no symlinks, `.dockerignore`/`Dockerfile.dockerignore` honored), tar-gzips it, and `POST`s it to Railway's `/project/{p}/environment/{e}/up?serviceId=…&message=…` — the `railway up` pipeline; Railway builds and deploys. `context` is mutually exclusive with `image` (without `main`) and `repo`. `builder` is an independent instance setting (RAILPACK/NIXPACKS/HEROKU/PAKETO — no DOCKERFILE value; a Dockerfile in the context is detected). `dockerfilePath` exists, relative to the context, default `Dockerfile`, validated to exist inside it. `image` (without `main`) deploys a prebuilt image from any registry Railway can pull — public refs work; **no `registry:` prop exists** (credentials plumbing exists in code but is hard-coded off; the API field is Pro-plan-only).
2. **Variables** — both shapes exist: `env?: Record<string, any>` on the Service (upserted service-scoped with `skipDeploys: true`, `Redacted` unwrapped) and a standalone `Railway.Variable` resource (`project`/`environment?`/`service?`/`name?`/`value`, also `skipDeploys: true`). Railway injects service variables at **build time too** — automatically for Railpack builds, via `ARG` only for Dockerfile builds. Docs steer secrets to `Config.Redacted` and keep `env` for known-plain values; a CI-provided commit SHA qualifies.
3. **Reserved `RAILWAY_*`** — the current Railway docs state **no rule** against user-created `RAILWAY_`-prefixed variables, and the docs themselves instruct users to *set* some (`RAILWAY_DOCKERFILE_PATH` as a service variable). A dashboard-vs-API difference is undocumented and unverified; the provider does no prefix validation. Treat any `RAILWAY_GIT_COMMIT_SHA`-style user variable as needing a probe; the neutral-name fallback stands.
4. **Base image** — for `main`, `FROM node:26-slim` (`hosted.ts:88`, `generateDockerfile`), overridable via the `image` prop; the generated entrypoint is Node, not Bun. The `oven/bun:1` text on https://alchemy.run/railway/compute/services is stale; the reference page and source agree on `node:26-slim`. For a `context:` build there is **no** provider-side base-image control; it is Railpack detection, or whatever `FROM` your Dockerfile declares. The RAILPACK knobs documented by Railway are `RAILPACK_*` variables / config-as-code, not provider props.
5. **`main` contract** — Effect-native only: the bundled program's default export must be an inline-effect class whose constructor Effect returns `{ fetch }` (or runs `host.run` loops); alchemy's Bootstrap serves it with Node HTTP on `PORT`. A plain Bun/Node entrypoint (our Elysia `node apps/server/dist/index.js`) does **not** fit `main` — confirmed from source. Use `context:` (or `image:`).
6. **Deploy mechanics** — a redeploy happens only when `alchemy deploy` runs, on content-hash change, unhealthy last deployment, or source change; after switching off `repo`, the provider disconnects the repo source and deletes the GitHub triggers. Tracking is the `code.hash` + `deploymentId`/`deploymentStatus` state attributes plus a fixed deploy message `alchemy {id} {codeHash}` (same channel as `railway up -m`). There is no commit-sha concept to piggyback: the API's `serviceInstanceDeployV2(commitSha)` validates against the connected repo (gone after the switch — unverified), the deploy message is not configurable, and `RAILWAY_GIT_COMMIT_SHA` stays absent on uploads. Re-source the deployed commit as a plain env Variable (`env:` prop or `Railway.Variable`) written by CI — the ADR-0128 fallback, now source-confirmed.
