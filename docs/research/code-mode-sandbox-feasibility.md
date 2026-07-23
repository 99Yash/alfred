# Code Mode sandbox — Phase 0 feasibility

**Question:** Is the "Phase 0 sandbox proof" for ADR-0087 / #271 (rung-(b) Code Mode) buildable on a
Node 22 API service on **Railway** (unprivileged container PaaS)? Can we run model-authored JS in a
sandbox that (a) holds no credentials, (b) has OS/container-enforced no-outbound-network, (c) exposes
only host functions over an IPC bridge?

**Location note:** `docs/research/` is an existing, conventional home for this repo's research notes
(alongside `mcp-*.md`, `workflows-v1-*.md`), so this lives there — next-door to the design at
`docs/plans/code-mode-object-handles-v1.md`.

**Date:** 2026-07-23. All facts below are from primary sources (npm registry, `laverdet/isolated-vm`
GitHub, man7.org man pages, nodejs.org, Vercel docs, Railway station, Deno docs) with URLs inline.

---

## Executive summary — verdicts

| # | Area | Verdict | One-line |
|---|------|---------|----------|
| 1 | `isolated-vm` on Node 22 | **GO (pin 6.1.2)** | Builds/runs on Node 22 with `--no-node-snapshot`. **Must pin `6.1.2`** — latest `7.0.0` requires **Node ≥26**; Node 20 is already dropped. Actively maintained but churning fast. |
| 2 | OS/container-enforced egress denial (unprivileged Railway) | **NO-GO as specified → PIVOT** | Railway forbids privileged/`cap-add`, so `iptables`/netns-via-`CAP_SYS_ADMIN` are out. The only unprivileged lever is **seccomp-bpf** (fragile under Node's thread pool) or **unprivileged userns+netns** (availability unverifiable, commonly disabled in containers). Practical ceiling = **app-level** no-network, which `isolated-vm` gives by construction. |
| 3 | `isolated-vm` async host-function bridge | **GO** | `Reference.applySyncPromise` (host returns a Promise, isolate call blocks synchronously until it settles) is the exact primitive for `load(handle)` awaiting R2 + vendor I/O in the trusted parent. |
| 4 | Alternatives | **PIVOT-ready** | `node:vm` is explicitly **not** a security boundary (disqualified). **quickjs-emscripten** (WASM QuickJS) is a *stronger* network-isolation story by construction — no syscalls at all — with asyncify host fns, at a perf cost. Deno `--deny-net` is app-level, not OS-level. |
| 5 | Vercel Sandbox (remote Firecracker microVM) | **NO-GO for ADR-0087 (custody)** | Strongest isolation of all options (dedicated-kernel microVM), but **runs in Vercel's cloud (AWS `iad1`)**, has **no host-callback channel**, and therefore forces the user's private reads off Railway into a third party — the exact objection that killed Freestyle.sh in ADR-0087 alt-(b). SOC 2 Type II is documented (better than Freestyle), but the custody model still breaks. |

**Bottom line:** target **local `isolated-vm@6.1.2` in a forked worker** for Phase 0, and **rewrite the
ADR's network claim**: OS-enforced egress denial is *not* achievable in an unprivileged Railway
container. The real containment is app-level (the isolate has no network bindings unless you inject
them — so don't), with seccomp-bpf as best-effort defense-in-depth if it survives testing. Keep
**quickjs-emscripten** as the documented fallback if native-build churn bites.

---

## 1. `isolated-vm` on Node 22

### Versions & engine support (npm registry — `https://registry.npmjs.org/isolated-vm`)

| Version | Published | `engines.node` |
|---------|-----------|----------------|
| 5.0.4 | 2025-03-03 | `>=18.0.0` (last line supporting Node 18/20) |
| 6.0.0 | 2025-05-20 | `>=24.0.0` |
| 6.0.1 | 2025-07-26 | `>=22.0.0` (walked back to 22) |
| 6.0.2 | 2025-10-19 | `>=22.0.0` |
| 6.1.0 | 2026-03-10 | `>=22.0.0` |
| 6.1.1 | 2026-03-11 | `>=22.0.0` |
| **6.1.2** | **2026-03-12** | **`>=22.0.0`** ← Node-22 target |
| 7.0.0 | 2026-05-31 | `>=26.0.0` ← **latest; excludes Node 22** |

`dist-tags`: `latest = 7.0.0`, `legacy = 1.7.11`. `gypfile: true` (native `node-gyp` build; prebuilt
binaries are published but see #548). Description: "Access to multiple isolates".

**So: the newest version that runs on Node 22 is `6.1.2` (2026-03-12).** Installing `isolated-vm`
without a pin on a Node 22 host will pull `7.0.0` and fail the engines check (Node ≥26). Phase 0 must
pin `"isolated-vm": "6.1.2"`.

### README requirements (`https://raw.githubusercontent.com/laverdet/isolated-vm/main/README.md`)

- "This project requires nodejs version 16.x (or later)."
- **"If you are using a version of nodejs 20.x or later, you must pass `--no-node-snapshot` to `node`."**
  → The forked worker must be spawned with `node --no-node-snapshot`. This is the single required runtime flag.
- Native compile: needs Python + build tools (`node-gyp`).

### Node 22 / 23 / 24 build history (GitHub issues, `laverdet/isolated-vm`)

- **#470** "Compile errors with node 22 on archlinux" — *closed* 2024-05-19. Root cause: Node 22's V8 API
  changes (`v8::Exception::Error` signature, `ObjectTemplate::SetAccessor` losing `v8::AccessControl`,
  C++20 template strictness). Fixed in the codebase; Node 22 support is in the shipped 6.x line.
- **#500** "Compile error with node v23.0.0" — *closed* 2024-10-22. Node 23 requires **C++20** (`"C++20 or
  later required"` fatal error) plus removal of `v8::CopyablePersistentTraits` / `SetAccessor`. Resolved
  in later releases.
- **#531** "feat: Node 24 support" — *closed* 2025-05-20 (i.e. 6.0.0).
- **#534** "Node 18, 20 backwards compatibility" — *closed* 2025-08-16. Confirms the project **dropped
  Node 18/20**; 6.0.1+ floors at Node 22.
- **#548** "Prebuilt binaries for version 6.1.0 incompatible with Ubuntu 22.04" — *closed* 2026-03-11.
  Shows the **prebuilt-binary path is not bulletproof**; a glibc/OS mismatch can force a from-source
  compile. Relevant because Railway's build image must have the toolchain or use a matching prebuilt.
- **#528** "Electron 35.2.0 (Node 22.14.0) — Build issue — C++ 20" — *open* (Electron-specific; not our case).

### Maintenance (GitHub API — `commits?per_page=10`)

Actively maintained. Recent commits (author Marcel Laverdet / contributors):
- 2026-06-17 "Reduce engine requirement to **24** (#561)"
- 2026-06-16 "Link to `@isolated-vm/experimental`"
- 2026-06-09 "Fix crash when async instantiate() resolve callback throws synchronously (#559)"
- 2026-06-08 build/CI fixes; 2026-06-04 README bump.

**Takeaway:** healthy cadence, single primary maintainer, but **aggressive engine churn** — 6.0.0 was
Node-24-only, walked back to 22, and 7.0.0 jumped to Node-26-only within ~13 months. There is a new
`@isolated-vm/experimental` package being surfaced. This is the biggest maintenance risk (see §6).

**Verdict: GO for Node 22 by pinning `isolated-vm@6.1.2` and launching the worker with
`--no-node-snapshot`.** Own the native-build toolchain in the Railway image; do not float the version.

---

## 2. OS/container-enforced outbound-network denial in an UNPRIVILEGED container (the crux)

### iptables / nftables egress deny — requires `CAP_NET_ADMIN`
Not available. Railway does not grant added capabilities or privileged mode (see below). **NO-GO.**

### Network namespaces (`unshare(CLONE_NEWNET)`)
Man page `unshare(2)` (`https://man7.org/linux/man-pages/man2/unshare.2.html`):
> "Use of CLONE_NEWNET requires the CAP_SYS_ADMIN capability."

So a bare `unshare -n` needs `CAP_SYS_ADMIN` — which an unprivileged process lacks. **However**, the
same man page and `user_namespaces(7)` (`https://man7.org/linux/man-pages/man7/user_namespaces.7.html`)
describe the unprivileged escape hatch:
> `user_namespaces(7)`: "Since Linux 3.8, unprivileged processes can create user namespaces" … "The
> child process created by clone(2) with the CLONE_NEWUSER flag starts out with a complete set of
> capabilities in the new user namespace." … "the other types of namespaces can be created with just
> the CAP_SYS_ADMIN capability in the caller's user namespace."
> `unshare(2)`: "since creating a user namespace automatically confers a full set of capabilities,
> creating both a user namespace and any other type of namespace in the same unshare() call does not
> require the CAP_SYS_ADMIN capability in the original namespace."

**So in principle** an unprivileged process can `unshare(CLONE_NEWUSER | CLONE_NEWNET)` and land in a
net namespace with no interfaces (loopback only) — real OS-level egress denial without any host
capability. **In practice this is unreliable inside a container:** unprivileged userns is frequently
disabled by the host (`sysctl kernel.unprivileged_userns_clone=0`, `user.max_user_namespaces=0`) or
blocked by the container runtime's default seccomp/AppArmor profile, and **Railway does not document
whether nested user namespaces are permitted** — it must be assumed off and probed empirically. Treat
as **unverified / likely blocked**.

### seccomp-bpf filtering `socket(2)`/`connect(2)` — the only reliably-unprivileged lever
Man page `seccomp(2)` (`https://man7.org/linux/man-pages/man2/seccomp.2.html`):
> "In order to use the SECCOMP_SET_MODE_FILTER operation, either the calling thread must have the
> CAP_SYS_ADMIN capability … *or* the thread must … `prctl(PR_SET_NO_NEW_PRIVS, 1)`." Without one of
> those, the operation "fails and returns EACCES". A filter "can be designed to filter arbitrary system
> calls" — including `socket`/`connect`.

So **an unprivileged process can install a seccomp filter after setting `no_new_privs`** and deny the
socket-family syscalls. This is the mechanism used by Anthropic's own `@anthropic-ai/sandbox-runtime`
(npm), whose seccomp filters block unix-domain sockets, and there is a thin `node-seccomp` npm wrapper
around `libseccomp`. **Caveat (primary source: the `node-seccomp` npm page):** "With Node.js and the
way it works with V8 and libuv, applying seccomp is somewhat more complicated than with simple C
applications due to various threads running underneath" — the filter must cover every libuv/V8 thread,
and `node-seccomp` is a low-traffic, lightly-maintained native addon (extra build-toolchain surface).
Also, whether the *container* runtime's own seccomp profile even permits a nested `seccomp()`/`prctl`
call on Railway is unverified.

### Railway capability posture (primary sources)
- Railway station feedback "Allow services to be run in privileged mode"
  (`https://station.railway.com/feedback/allow-services-to-be-run-in-privileged-m-8c66b22b`) — the only
  Railway-staff response (user "brody"): **"You simply can't do such things on Railway.. Yet."**
- Railway station "Docker in Docker" thread confirms nested containerization / runtime installs are
  blocked. Railway builds from Nixpacks **or** a Dockerfile (`https://docs.railway.com/builds/dockerfiles`),
  but the *runtime* container is unprivileged; the Dockerfile controls image contents, not kernel
  capabilities. No documented `--cap-add`, `--privileged`, or custom-seccomp-profile knob exists.

### Realistic verdict — **PIVOT the ADR's network claim**
OS/container-enforced egress denial as ADR-0087 words it ("enforced by the OS/container, not just
app-level") is **not achievable in an unprivileged Railway container** via any first-class,
documented, capability-based mechanism:
- `iptables`/`nftables`/`CAP_NET_ADMIN` — **NO-GO** (Railway forbids capability grants).
- bare `unshare -n` / `CLONE_NEWNET` — **NO-GO** (needs `CAP_SYS_ADMIN`).
- `CLONE_NEWUSER|CLONE_NEWNET` (unprivileged userns) — **unverified, likely blocked**; probe before relying.
- **seccomp-bpf socket-family deny** — **the one unprivileged-viable path**, but fragile under Node's
  thread pool and dependent on Railway not blocking nested seccomp; treat as *best-effort
  defense-in-depth*, not a guarantee.

**The practical ceiling is app-level no-network**, and this is exactly where `isolated-vm` shines: a
fresh isolate has **no `fetch`, no `net`/`http`, no `require`, no syscalls** — it can only touch what
the host injects. If we inject only `load`/`broker.read`/`broker.write` and nothing network-shaped,
the injected code has nothing to send and no way to send it. That is ADR-0087's *actual* containment
(and the doc already acknowledges the residual boss-orchestrator-egress problem is out of scope). The
ADR should stop claiming OS-level enforcement and instead claim: **"capability-addressed sandbox with
zero network bindings; seccomp-bpf socket-deny attempted as defense-in-depth (best-effort on
Railway)."**

---

## 3. `isolated-vm` async host-function bridge (for `load(handle)` awaiting R2 + vendor I/O)

From the README API (`https://github.com/laverdet/isolated-vm`, README):

- **`new ivm.Reference(value)`** — wraps a host-side value/function; the isolate gets a handle it cannot
  read into directly.
- Invocation variants on a `Reference` to a host function:
  - `reference.applySync(receiver, args, opts)` — synchronous.
  - `reference.apply(receiver, args, opts)` — returns a Promise **to the host** (async), not usable to
    block isolate code.
  - `reference.applyIgnored(...)` — fire-and-forget, returns `undefined` immediately.
  - **`reference.applySyncPromise(receiver, args, opts)`** — the key one: the **host** function may
    return a **Promise**; the calling isolate is **blocked synchronously** until that Promise settles,
    then receives the resolved value. This is only callable from a *non-default* isolate (i.e. exactly
    our forked-worker isolate calling back into the trusted parent), which is the intended use.
- **`new ivm.Callback(fn, { async | sync | ignored })`** — when a `Callback` is transferred into the
  isolate "instances of `Callback` will turn into a plain old function"; `async: true` "immediately
  returns a promise", `sync: true` blocks (default), `ignored: true` returns `undefined`. Args and
  return values "are always copied using the same method as `ExternalCopy`."
- **`new ivm.ExternalCopy(value)`** with `.copyInto(opts)` / `.copy(opts)` / `.release()` — the
  structured-clone transfer mechanism across the isolate boundary (used implicitly by callbacks).

**Recommended pattern for `load(handle)`** (paged cursor that awaits R2 + vendor HTTP in the trusted
parent):

1. In the parent, define the async host fn `hostLoad(handleJson, cursorJson)` returning a Promise of a
   page (plain JSON-cloneable object).
2. Wrap as `const ref = new ivm.Reference(hostLoad)` and inject `ref` into the isolate's global
   (via `jail.set('__load', ref)` where `jail = context.global`).
3. Inside the isolate, expose a friendly async-looking shim that calls
   `__load.applySyncPromise(undefined, [handle, cursor])` — the isolate call blocks until the parent's
   R2+vendor Promise resolves, then returns the copied page. (Alternatively inject an
   `ivm.Callback(hostLoad, { async: true })` so isolate code sees a normal promise-returning function;
   `applySyncPromise` is preferred when you want simple synchronous-looking cursor code inside the
   isolate and the trusted parent to own concurrency.)
4. Arguments/results cross via `ExternalCopy` semantics — keep them JSON-cloneable; don't try to pass
   live objects/functions from parent into isolate except as `Reference`/`Callback`.

**Verdict: GO.** `applySyncPromise` is purpose-built for "isolate calls a host fn that does async I/O
in the trusted process and returns a value." Confirmed against the README; validate empirically against
a real paged R2 read in Phase 0 (the ADR's open verification item).

---

## 4. Alternatives if `isolated-vm` is problematic on Node 22

### `node:vm` + `worker_threads` — **NOT a security boundary. Disqualified.**
Node docs (`https://nodejs.org/api/vm.html`), first line of the module:
> **"The `node:vm` module is not a security mechanism. Do not use it to run untrusted code."**
A `worker_thread` gives you a separate event loop and heap but **shares the process, the OS user, and
all ambient authority** (filesystem, `fetch`, `net`, env). Running model-authored code in `node:vm`
(even inside a worker) is not an isolation story. Only viable as the *transport* (the forked worker
that *hosts* `isolated-vm`), never as the sandbox itself.

### quickjs-emscripten (WASM QuickJS) — **strongest local-in-process isolation, PIVOT-ready**
Primary source: README (`https://github.com/justjake/quickjs-emscripten`).
- **What:** "Javascript/Typescript bindings for QuickJS … compiled to WebAssembly." Tagline: "Safely
  evaluate untrusted Javascript (supports most of ES2023)."
- **Isolation by construction:** "By default, no host functionality is exposed to code running inside
  QuickJS." Because the interpreter is **WASM**, it has **no syscalls, no ambient network, no
  filesystem at all** — the WASM sandbox cannot even *name* `socket`/`connect`. This is a *strictly
  stronger network-isolation story than `isolated-vm`*: with `isolated-vm` the isolate is
  syscall-free-by-policy (nothing injected), whereas with WASM QuickJS it is syscall-free **by the
  execution model** — there is no code path from guest JS to a host syscall except the host functions
  you explicitly wire. This directly resolves §2: the OS-enforcement question becomes **moot**, exactly
  as ADR-0087 hoped ("no network in the isolate at all"), without depending on seccomp/userns.
- **Async host functions:** supported via **Asyncify** — `newAsyncRuntime`/`newAsyncContext`,
  `context.newPromise()` + `context.resolvePromise()`, and `newAsyncifiedFunction` ("Async on host,
  sync in QuickJS"). This maps cleanly onto `load(handle)` awaiting R2 in the parent.
- **Resource limits:** `runtime.setMemoryLimit(bytes)`, `runtime.setInterruptHandler(...)` (interrupt
  after N ticks), `runtime.shouldInterruptAfterDeadline(Date.now()+ms)`. Built-in memory + wall-clock
  caps (the ADR wants these).
- **Cost:** the README notes asyncify builds are "bigger and run slower" (~2× larger, 1 MB vs 500 KB
  variant). QuickJS is an **interpreter** (no JIT), so raw compute is materially slower than V8/
  `isolated-vm`. For "compute a derived result over a parked handle" (mostly filtering/reshaping JSON,
  I/O-bound on `load`) this is very likely acceptable; for heavy CPU it is not.
- **Maintenance/portability:** pure npm install, **no native `node-gyp` build**, no Node-ABI coupling —
  so it sidesteps the entire §1 engine-churn risk and runs on Node 22/24/26/Bun identically.

**Verdict: keep as the documented fallback and arguably the safer substrate.** If `isolated-vm`'s
native-build/engine churn (see §6) becomes painful, quickjs-emscripten is the pivot — it trades peak
CPU throughput for a no-native-build, syscall-free-by-construction isolate that makes the network
question disappear.

### Deno subprocess (`--deny-net`) — app-level, OS-agnostic; not OS-enforced kernel policy
Deno docs (`https://docs.deno.com/runtime/fundamentals/security/`):
> "Deno is secure by default. Unless you specifically enable it, a program run with Deno has no access
> to sensitive APIs, such as file system access, network connectivity, or environment access."
> "`--deny-*` flags override their `--allow-*` counterparts" (e.g. `--allow-read --deny-read=/etc`).
> Scoped net: `--allow-net=example.com`.
A `deno run --deny-net` subprocess is a clean **app-level** egress control enforced by the Deno runtime
(not the kernel), portable across OSes, no capabilities needed. But it means adopting a **second
runtime** on Railway and an IPC/subprocess bridge, and it's still runtime-enforced (a Deno escape =
network) rather than kernel-enforced. Reasonable, but heavier than `isolated-vm`/quickjs for our
in-process needs; note as a tertiary option. (Bun has no comparable per-run permission sandbox model —
not a fit.)

---

## 5. Vercel Sandbox (remote Firecracker microVM) — head-to-head vs local `isolated-vm`

Primary sources: `https://vercel.com/docs/sandbox`, `/sandbox/concepts`, `/sandbox/pricing`,
`/sandbox/sdk-reference`.

### What it is
- "A compute primitive designed to safely run untrusted or user-generated code on Vercel … isolated,
  ephemeral Linux VMs." Each sandbox = its **own [Firecracker] microVM with a dedicated kernel**.
- Runtime image: **Amazon Linux 2023**, runtimes `node26`/`node24`/`node22`/`python3.13` (default
  `node24`); full root + `sudo` inside.
- **Limits/pricing** (`/sandbox/pricing`): max duration **45 min (Hobby) / 24 h (Pro/Ent)**; up to
  4 vCPU/8 GB (Hobby) → 32 vCPU/64 GB (Ent); 32 GB ephemeral NVMe. "Sandboxes start in milliseconds"
  (Firecracker fast-boot). Billing: **Active CPU $0.128/vCPU-hr**, **Provisioned memory $0.0212/GB-hr**,
  **creations $0.60/1M**, **egress data transfer $0.15/GB** (inbound downloads free). Region: **`iad1`
  only** (AWS us-east-1).

### (2) Execution locus — **remote, in Vercel's cloud. Cannot run on our infra.**
> "When you call `Sandbox.create()`, Vercel provisions a Firecracker microVM **on its infrastructure**
> … The sandbox runs on Vercel's global infrastructure." Auth is via a Vercel OIDC token / access
> token tied to a Vercel project. There is **no self-host option** — the microVM is on AWS `iad1`.

### (3) Network model
> "Sandboxes can make outbound HTTP requests by default" (to install npm/PyPI packages). Egress **can**
> be restricted: "Internet access from the sandbox can be restricted through network policies … as part
> of the sandbox firewall." Exposed ports get a **public URL**. So egress-deny is achievable here (unlike
> Railway) — but that is beside the point given the custody problem below.

### (4) Callback channel to Alfred's trusted parent — **there is none.**
The JS SDK surface (`/sandbox/sdk-reference`) is a **remote-VM control plane**, not a host-function
bridge:
- `Sandbox.create/get/getOrCreate/stop`, `sandbox.runCommand()` (args + streamed `stdout`/`stderr`,
  `exitCode`), `sandbox.writeFiles()` / `readFile()` / `readFileToBuffer()` / `mkDir()`,
  `sandbox.domain(port)` (public URL for an exposed port), snapshots/tags/drives.
- **No synchronous RPC / host-callback primitive** exists for code *inside* the sandbox to call back
  into the parent. Data flows **in** via `writeFiles` + command args and **out** via `stdout`/`readFile`.
- Therefore, to implement `load(handle)`/`broker.read`, the only options are: **(a)** ship all needed
  private data *into* the sandbox at creation via `writeFiles` (i.e. copy the parked Gmail/GitHub/Railway
  reads to Vercel), or **(b)** have the sandboxed code make an **inbound network call to Alfred's public
  API on Railway** (requires exposing an authenticated broker endpoint publicly + shipping a bearer token
  into the untrusted sandbox — precisely the "public cred-broker + route private reads through the
  boundary" shape ADR-0087 rejected). Neither preserves the containment model.

### (5) Data-custody verdict — **same objection that killed Freestyle.sh (ADR-0087 alt-(b)).**
ADR-0087's containment is: *the sandbox holds no credentials and private data is fed by host functions
running in the trusted parent, so data never leaves Alfred's infra.* Vercel Sandbox is remote, so to
compute over a parked handle **the user's private reads must be shipped to Vercel's cloud (AWS
us-east-1)** — this is categorically the Freestyle.sh objection ("routes the user's private reads
through a third party"). What Vercel documents *better* than Freestyle: **"Sandboxes run on Vercel's
secure infrastructure, which maintains SOC 2 Type II certification,"** they are ephemeral (no long-term
persistence unless you snapshot), and region is pinned to `iad1`. And the **isolation is genuinely
stronger** than `isolated-vm`: a dedicated-kernel Firecracker microVM ("microVM boundary prevents
escapes"; "container escapes are possible" for shared-kernel) is a hardware-virtualization boundary,
strictly above a V8-isolate boundary. **But isolation strength is not the binding constraint here —
data custody is.** A V8 escape in a *local* isolate compromises a Railway worker that already holds no
creds; shipping the private data to a third party is a *data-location* regression that a stronger
sandbox boundary does not undo. **NO-GO for ADR-0087's stated model.** (It would only make sense if the
product decision changed to "third-party compute is acceptable with SOC 2" — a decision the ADR
explicitly declined.)

---

## 6. Recommended substrate for Phase 0

### Comparison

| Axis | Local `isolated-vm@6.1.2` | Local quickjs-emscripten (WASM) | Vercel Sandbox (remote µVM) |
|---|---|---|---|
| Isolation strength | V8 isolate (strong; escapes rare but in-process) | WASM sandbox (strong; **no syscalls by construction**) | **Firecracker microVM (strongest)** |
| OS-network-denial effort on Railway | N/A — **no net bindings by default**; seccomp best-effort add-on | **Moot** — no syscalls at all, nothing to deny | Egress firewall available (but remote) |
| Data custody | ✅ Stays on Railway | ✅ Stays on Railway | ❌ **Private reads shipped to Vercel/AWS** |
| Node-22 build risk | ⚠️ Native `node-gyp`; **must pin 6.1.2**; engine churn (v7=Node26) | ✅ No native build; runtime-agnostic | ✅ N/A (remote, offers `node22`) |
| Operational weight | Medium (forked worker + IPC + toolchain in image) | Low (npm dep, in-process) | High (remote lifecycle, OIDC, egress $, region, new vendor) |
| Host-fn / async-`load` ergonomics | ✅ `applySyncPromise` / `Callback{async}` | ✅ Asyncify (`newAsyncifiedFunction`) | ❌ No callback channel — files/args/stdout only |

### Recommendation
**Phase 0 should target local `isolated-vm@6.1.2` in a `--no-node-snapshot` forked worker**, matching
the ADR's locked substrate — it satisfies data custody, gives the async host-fn bridge
(`applySyncPromise`) the design needs, and provides zero-network-by-default at the app level. Pair it
with a **best-effort seccomp-bpf socket-deny** attempt as defense-in-depth (and *measure* whether it
survives Node's libuv threads on Railway; if not, drop it and rely on the no-bindings guarantee).

**Correct the ADR's language now:** it claims OS/container-enforced no-network; on unprivileged Railway
that is **not attainable**. Reframe as "capability-addressed isolate with no network bindings +
best-effort seccomp." This is honest and still closes the injected-code-exfil path the ADR actually
cares about.

**Keep quickjs-emscripten as the sanctioned pivot.** If `isolated-vm`'s native build or engine churn
costs real time (it will need re-pinning every time Railway's Node baseline moves, and 6.x is one major
behind), the WASM route removes the entire native-build + OS-network problem at a CPU-throughput cost
that is almost certainly acceptable for handle-reshaping work. Consider prototyping *both* `load()`
bridges in Phase 0 to de-risk the pivot.

**Reject Vercel Sandbox and `node:vm`.** Vercel Sandbox has the best isolation but breaks data custody
(the decided-against Freestyle objection) and has no host-callback channel. `node:vm` is explicitly not
a security boundary.

### Single biggest risk of each
- **`isolated-vm`:** engine/ABI churn + native build. Latest (`7.0.0`) already excludes Node 22 (needs
  ≥26) and Node 20 is dropped; prebuilt binaries have shipped broken (#548). Phase 0 must pin `6.1.2`,
  bake the compile toolchain into the Railway image, and budget for a forced version bump whenever
  Railway's Node baseline changes.
- **quickjs-emscripten:** interpreter performance — a genuinely CPU-heavy `code.run` (not just JSON
  reshaping) could exceed the wall-clock cap where V8 would not.
- **Vercel Sandbox:** data custody — using it means the user's private data leaves Railway for a third
  party, reversing ADR-0087's core containment decision.

---

## Sources
- npm registry: `https://registry.npmjs.org/isolated-vm`
- `isolated-vm` README: `https://github.com/laverdet/isolated-vm` (main README)
- `isolated-vm` issues #470, #500, #531, #534, #548, #528, #561; commits API `laverdet/isolated-vm`
- `unshare(2)`: `https://man7.org/linux/man-pages/man2/unshare.2.html`
- `user_namespaces(7)`: `https://man7.org/linux/man-pages/man7/user_namespaces.7.html`
- `seccomp(2)`: `https://man7.org/linux/man-pages/man2/seccomp.2.html`
- `node-seccomp` npm; `@anthropic-ai/sandbox-runtime` npm
- Railway: `https://station.railway.com/feedback/allow-services-to-be-run-in-privileged-m-8c66b22b`, `https://docs.railway.com/builds/dockerfiles`
- Node vm module: `https://nodejs.org/api/vm.html`
- quickjs-emscripten README: `https://github.com/justjake/quickjs-emscripten`
- Deno security: `https://docs.deno.com/runtime/fundamentals/security/`
- Vercel Sandbox: `https://vercel.com/docs/sandbox`, `/docs/sandbox/concepts`, `/docs/sandbox/pricing`, `/docs/sandbox/sdk-reference`
