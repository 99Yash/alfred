# Structural review exemplars

This file holds the worked examples for [structural-review.md](./structural-review.md). Read it when a rule there is not clear enough to apply. It does not add rules.

## The six axes, in this tree

- **Repetition.** The localStorage registry replaced scattered `window.localStorage` calls. `parseEmailAddress` is the single source of self-mail matching.
- **Conflation.** `isRecord` answered two questions: "is this plain JSON?" and "can I read a field from this?". A `Date` answers them in opposite ways. The split into `isRecord` and `isIndexable` gave each question one name.
- **Wrong dependency direction.** `contracts` must not reach into `api`. The header of the storage schemas guards against a `storage-schemas → domain → storage` cycle.
- **Loose representation.** `satisfies Record<string, z.ZodDefault>` makes "a registered key with no default" impossible to write.
- **Reinvention.** A hand-written insert type where `$inferInsert` exists. A manual JSON try/catch where zod exists.

The registry improves three axes (1, 5 and 6). The guard split improves two (2 and 5). The registry began with a repetition tell, and it needed the global claim that all keys form one catalog. The guard split needed a reader to see two concepts behind one name.

## Enforcement tiers, in this tree

- **Tier 1.** `satisfies Record<string, z.ZodDefault>`: a key without a default does not build. `LocalStorageValue<K>` derives from the schema, so the type cannot drift. The `const _exhaustive: never` switch guard. `check:web-boundaries` rejects a forbidden import.
- **Tier 2.** `setLocalStorageItem` refuses an invalid value with `safeParse`.
- **Tier 3.** The registry is the one catalog. `safeGet`, `safeSet` and `safeRemove` are the intended door to `window.localStorage`.
- **Tier 4.** `guards.test.ts` catches an `isRecord` regression, but it does not stop someone who widens it again.
- **Tier 5.** "Do not call `window.localStorage` outside `storage.ts`" has no check. The sibling browser and server import rule moved from tier 5 to tier 1 when `check:web-boundaries` arrived. That is the upgrade the ladder asks for.

A cast (`as`) asks the compiler to trust a claim that it did not prove. It is a tell for axis 5, not automatically a defect. Find the owning boundary, and decide whether a parse or a derived type can replace the claim.

## Required knowledge

### The escape hatch that the multi-edit test missed

`AuthedJsonOptions.onError` was an open callback: "override the non-2xx branch". It had one implementer. A change to the error posture of Notion was a one-line edit in one file. By the multi-edit test it was clean. It was still debt: the policy it encoded ("the error body of this provider must never ride the error") was visible only to a reader of the Notion client. `bodyPolicy: "summarize" | "omit"` on the factory that every client already calls put the same decision in autocomplete.

### A name you must already know

Each row of the [shared helpers](./shared-helpers.md) table is a capability that only documentation finds. A caller that holds `unknown` cannot see `getPath`. A caller that holds a `credentialId` cannot see `getFreshAccessToken`. `integrations({ userId }).github.search({ q })` replaces three facts: that `getInstallationTokenForUser` exists, that its token must not be logged, and that `searchGithub` takes it.

### A leaky primitive

`grep -ro 'accessToken: string' packages/integrations/src | wc -l` returned 62 on the last count, down from 68 as GitHub and Vercel moved behind the user-bound integrations root. Count it again before you use the number. One CLAUDE.md bullet governs all of those sites: never log the token, never persist it on an error, never read the stale one.

A type can carry that policy. `Redacted<T>` masks the value under `String()`, `JSON.stringify` and `util.inspect`. It keeps the plaintext in a `#private` field, so a structured logger finds nothing. It exposes one greppable `unwrap()`, which the function that builds the headers calls.

The positive form is in the tree. The public `CredentialRow` of Google has no `accessToken` field, so "do not read the persisted token" is tier 1 for that path. `getFreshAccessToken(): Promise<string>` then returns a bare string again. The same invariant is static on one side of a function and prose on the other side. That contrast is the up-finding.

### A restated shape

`ProviderBindOptions` is the one bind shape, and the public type of the integrations root maps from `ReturnType` for each registry entry. `FLOOR_SEQUENCE` is the ordered list of triage floors, and the audit keys of `FloorOutcome` map from it. The fold of the triage floors made the threading structural: each floor now receives the classification of the previous floor. Before, three hand-written calls each had to pass `previous.classification`, and the original value would have disabled a floor with no error.

### The vocabulary ledger

`bodyPolicy` removed `notionError` and `onError`, and it added one field to an options object that callers already pass. The ledger was negative, and the change was finished. #551 is a closed debt clock: it moved tool modules behind `ctx.integrations`, removed the Google credential resolver of the tool layer, and left the credential primitives only to the integration-owned and background paths that still own them.

### The hazard rule

The header of `fetchWithRetry` said that retry "must be used for idempotent reads (GET/HEAD)". `defineProviderClient.json` accepted `method` and `body` and retried every request. A POST that reached the upstream and then timed out would have been sent again. The docstring was the enforcement. The client now gates on `isRetrySafeMethod`, and any other method must pass `idempotent: true` (tier 5 to tier 1). The same client also could not express `bodyPolicy`, so the one provider that needs `"omit"` could not join the seam.

Two corollaries from the same seam:

- `retry?: RetryPolicy` looked optional, but absence meant "retry with the built-in policy". Each GitHub and Vercel read gained three attempts with no notice, and "no retry" could not be written. `retry: RetryPolicy | "none"`, required at the bind, made the choice visible.
- A bind-scoped `once()` around a credential resolve looked like the memo of client construction. A memo with no expiry around a token with an expiry made a lifetime rule for the caller: "a bind is request-scoped", in four docstrings and enforced by nothing. A bind held at module scope gets 401 forever. The expiry-aware cache of the provider already had the property. The seam had only to keep it.

## Structure so aligned that the coordination is inevitable

The up-pass can aim only at a shape that the reviewer has internalized. This section reads one codebase that many engineers call exemplary, and extracts its moves as the positive form of the six axes.

The codebase is Andre Weissflog's [`floooh/chips`](https://github.com/floooh/chips): dependency-free 8-bit chip and computer emulators, each a single C header. Salvatore Sanfilippo (creator of Redis) called it _"poetry-code that I would frame in my wall."_ The language is C and the domain is silicon. Each move below applies to any language and domain.

1. **One protocol, many implementations.** Every chip exposes `<chip>_init`, `<chip>_reset` and `<chip>_tick(state, pins) → pins`. `pins` is one `uint64_t` that carries the whole bus. A computer is then wiring: the system tick passes the output pins of one chip to the input of the next. Axes 3 and 1, tier 1: the shared signature is the contract. In review, measure each integration and tool against one dispatch contract. When the next integration needs its own calling convention, the seam is not at the joint.
2. **State is a value, so save, load and replay are free.** The whole emulator state is a plain struct with no owned heap graph. A snapshot is `*dst = *src` plus hooks that repatch a few live pointers, with one version integer that refuses a mismatched layout. Axis 5 and source/derivation, tiers 1 and 2. In review, flag state that only a rerun of side effects can rebuild, and any projection that cannot be replayed from its source (compare the observation log of ADR-0067).
3. **Generate the bulk that changes together from a spec in the domain's words.** The Z80 decoder (about 1,700 steps) comes from `z80_desc.yml`, which describes each opcode in machine cycles. The generator writes the switch between markers in the same header, so it regenerates idempotently. Axes 1 and 6, tiers 1 and 3. In review, ask whether one table generates the code for a table-shaped domain (tool catalog, model capability map, fact ontology), or whether N hand-written branches hold the table.
4. **Stable primitives do not know their compositions.** A chip header knows nothing about a computer that uses it. Shared helpers (`mem.h`, `kbd.h`, `clk.h`) sit at the bottom. Dependencies point one way: system, then chip, then substrate. Axis 4, tier 1 where a boundary check exists. In review, `@alfred/contracts` and `@alfred/sync` are the stable primitives. A shared module that imports an app-specific one is the violation.
5. **The source carries its own schematic and names its shortcuts.** `z80.h` opens with a pin diagram and a progressive HOWTO. `c64.h` embeds its test results and marks each known failure with a reason (`cia1ta: FAIL (OK, CIA sysclock not implemented)`). The README states where the emulation is impure. This answers comprehension obstruction, at tier 5 but with real value. In review, an ADR or header that states the invariant, the shortcut and the residual risk has done the bookkeeping of the down-pass in advance.

In each case the structure of the code is a faithful image of the domain: a chip is a struct, a bus is an integer, a computer is a wiring function, and the opcode table is a table. When the map is that faithful, one domain change lands in one place, because no other place exists.
