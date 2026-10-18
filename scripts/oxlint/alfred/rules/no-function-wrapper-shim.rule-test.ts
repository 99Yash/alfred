import { RuleTester } from "oxlint/plugins-dev";

import { noFunctionWrapperShimRule } from "./no-function-wrapper-shim.ts";

// The spec of `no-function-wrapper-shim`. The cases above each "new" banner
// moved here from `scripts/consolidation-rules.selftest.mjs`, where the rule was
// a regex. Each one keeps its outcome: a must-catch fixture is an `invalid`
// case, and a must-ignore fixture is a `valid` case. The cases below the
// banners are the holes #1377 listed, which the AST closes.
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid`
// case without a `filename` through the root `.oxlintrc.json`.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const error = { messageId: "wrapperShim" };

tester.run("alfred/no-function-wrapper-shim", noFunctionWrapperShimRule, {
  valid: [
    {
      name: "a body with logic is not a forwarder",
      code: `export function maxMutations() {
  return clampLimit(MAX_MUTATIONS);
}`,
    },
    {
      // `apps/web/src/lib/events/event-stream-status.ts`: a getter over a module
      // `let` that changes at run time is a live read, not a second door.
      name: "a typed getter over a module let",
      code: `let eventStreamStatus: EventStreamStatus = "disconnected";

export function setEventStreamStatus(next: EventStreamStatus) {
  eventStreamStatus = next;
}

export function getEventStreamStatus(): EventStreamStatus {
  return eventStreamStatus;
}`,
    },
    {
      // The same live read with no return type. The old regex flagged this.
      name: "an untyped getter over a module let",
      code: `let eventStreamStatus = "disconnected";

export function getEventStreamStatus() {
  return eventStreamStatus;
}`,
    },
    {
      // `tool-runtime/internal/dispatch/staging-store.ts`: the `let` starts as
      // an imported value and a test seam swaps it. The import of a different
      // name does not make the getter a shim.
      name: "a typed getter over a let seeded from an import",
      code: `import { postgresStagingStore } from "./postgres-staging-store";

let activeStagingStore: StagingStore = postgresStagingStore;

export function stagingStore(): StagingStore {
  return activeStagingStore;
}`,
    },
    {
      // `packages/auth/src/hooks.ts`: the const is an unexported mutable array,
      // and the return type narrows it to a readonly view. Nothing else exposes it.
      name: "a typed readonly view of an unexported container const",
      code: `const _hooks: OnUserCreatedHook[] = [];

export function registerOnUserCreated(fn: OnUserCreatedHook): void {
  _hooks.push(fn);
}

export function getOnUserCreatedHooks(): readonly OnUserCreatedHook[] {
  return _hooks;
}`,
    },
    {
      name: "an arrow getter over a module let",
      code: `let current: Mode = "idle";

export const currentMode = (): Mode => current;`,
    },
    {
      // An identity function returns its parameter. The old regex flagged this.
      name: "a wrapper that returns its parameter",
      code: `export function identity(value) {
  return value;
}`,
    },
    {
      // A `const` inside another function body is not a module binding.
      name: "a typed getter whose name is only a nested const",
      code: `export function load(): void {
  const cache = 50;
  use(cache);
}

export function cacheRef(): Cache {
  return cache;
}`,
    },
    {
      // A later declarator of a module `let` is a live read too.
      name: "an untyped getter over the second declarator of a let",
      code: `let retries = 0,
  lastError = null;

export function getLastError() {
  return lastError;
}`,
    },
    {
      // The parameter guard reads the parameter list, so a return type that ends
      // in a paren does not make the wrapper look untyped over an unresolved name.
      name: "a wrapper that returns its parameter under a paren return type",
      code: `export function asListener(listener: Listener): (() => void) {
  return listener;
}`,
    },
    {
      // Only a namespace member is related. A named import can be a mutable
      // object, so a getter over its property can be a live read.
      name: "a typed getter over a property of a named import",
      code: `import { runtimeConfig } from "./runtime-config";

export function apiUrl(): string {
  return runtimeConfig.apiUrl;
}`,
    },
    {
      name: "an arrow typed on the variable over a module let",
      code: `let current: Mode = "idle";

export const currentMode: () => Mode = () => current;`,
    },
    {
      // The parameter guard still reads a parameter list that holds parens.
      name: "a wrapper that returns its function-typed parameter",
      code: `export function identity(cb: () => void) {
  return cb;
}

export const passThrough = (cb: (x: number) => void): ((x: number) => void) => cb;`,
    },
    {
      // `C.X.y` reads a property of the export `X`, which can be a mutable
      // object: the same live read as `return X.y` over a named import.
      name: "a typed getter over a property of a namespace member",
      code: `import * as config from "./runtime-config";

export function apiUrl(): string {
  return config.runtimeConfig.apiUrl;
}`,
    },
    {
      name: "an untyped getter over a later declarator with an initializer",
      code: `let retries = 0, lastError = null;
let status = "idle",
  pending;

export function getLastError() {
  return lastError;
}

export function getPending() {
  return pending;
}`,
    },
    {
      // The module writes to the value below the getter. The return type narrows
      // a value that changes, as for `getOnUserCreatedHooks` above.
      name: "a typed readonly view of a const that the module writes below it",
      code: `const state: State = { count: 0 };

export function readState(): Readonly<State> {
  return state;
}

export function bump(): void {
  state.count += 1;
}`,
    },
    {
      // A destructured parameter and a rest parameter are bindings too.
      name: "wrappers that return a destructured or rest parameter",
      code: `export function pick({ value, id }) {
  return value;
}

export const rest = (first, ...others) => others;`,
    },
    {
      // The parameter guard reads a parameter list three levels deep too.
      name: "a wrapper that returns a parameter typed three levels deep",
      code: `export function identity(cb: (next: (n: number) => void) => void) {
  return cb;
}`,
    },
    // ---------------------------------------------------------------------
    // New with the AST rule. The next two cases also pass under the regex
    // rule; they hold the read/write line and the file scope in place.
    // ---------------------------------------------------------------------
    {
      // The other side of the read/write line (hole 1): the module changes
      // each value, so each typed getter narrows a value that changes. A value
      // passed to a call (`register(hooks)`), a method off the read-only list
      // (`cache.set`), a write through a property path (`state.count++`,
      // `delete flags.beta`), an alias (`const pending = queue`) and a
      // property handed to a call (`schedule(config.retry)`) each count.
      name: "typed getters over consts that the module changes in each way",
      code: `const hooks: Hook[] = [];
const cache = new Map<string, Entry>();
const state = { count: 0 };
const flags: Flags = { beta: true };
const queue: Job[] = [];
const config = { retry: { max: 3 } };

register(hooks);

export function remember(key: string, entry: Entry): void {
  cache.set(key, entry);
}

export function bump(): void {
  state.count++;
  delete flags.beta;
  const pending = queue;
  drain(pending);
  schedule(config.retry);
}

export function getHooks(): readonly Hook[] {
  return hooks;
}

export function getCache(): ReadonlyMap<string, Entry> {
  return cache;
}

export function readState(): Readonly<State> {
  return state;
}

export function getFlags(): Readonly<Flags> {
  return flags;
}

export function getQueue(): readonly Job[] {
  return queue;
}

export function getConfig(): Readonly<Config> {
  return config;
}`,
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`),
      // so a test tree is out of scope.
      name: "a wrapper in a test tree is out of scope",
      filename: "packages/assistant/test/support/limits.ts",
      code: `export function maxMutations() { return MAX_MUTATIONS; }`,
    },
    // ---------------------------------------------------------------------
    // The holes #1377 left open, closed by the AST. Each case below was
    // wrong under the regex rule.
    // ---------------------------------------------------------------------
    {
      // Hole 5: a renamed destructured parameter (`{ id: value }`) binds
      // `value`. The regex read only the key position, so it flagged this
      // identity as an untyped wrapper over an unresolved name.
      name: "a wrapper that returns a renamed destructured parameter",
      code: `export function pick({ id: value }) {
  return value;
}`,
    },
    {
      // Hole 6: a `let` binds every name in its pattern. The regex read a
      // `let` only by the name after `let` or after a comma, so it flagged an
      // untyped getter over a destructured `let`.
      name: "an untyped getter over a destructured module let",
      code: `let { retries } = loadState();

export function getRetries() {
  return retries;
}`,
    },
  ],
  invalid: [
    {
      // `no-function-wrapper-shim` — a function that only forwards to a constant.
      name: "the hand-collapsed one-liner",
      code: `export function maxMutations() { return MAX_MUTATIONS; }`,
      errors: [error],
    },
    {
      // Why the rule is `scope: "chain"`: the formatter puts the body on its own
      // line, and the line rule this used to be matched none of these.
      name: "the wrapper the formatter wrote across three lines",
      code: `export function maxMutations() {
  return MAX_MUTATIONS;
}`,
      errors: [error],
    },
    {
      // The return-type hole: the old regex required `)` directly before `{`.
      // Statements between the import and the wrapper do not hide it.
      name: "a typed wrapper over a named import",
      code: `import { MAX_MUTATIONS } from "./constants";
import type { Mutation } from "./types";

const log = createLogger("sync");

export function maxMutations(): number {
  return MAX_MUTATIONS;
}`,
      errors: [error],
    },
    {
      name: "a typed wrapper over an exported module const",
      code: `export const DEFAULT_SYNC_OPTIONS = { batch: 50 } as const;

export function defaultSyncOptions(): typeof DEFAULT_SYNC_OPTIONS {
  return DEFAULT_SYNC_OPTIONS;
}`,
      errors: [error],
    },
    {
      // The const can come after the wrapper: the wrapper reads it at call time.
      name: "a typed wrapper over a literal const declared below it",
      code: `export function pageSize(): number {
  return PAGE_SIZE;
}

const PAGE_SIZE = 50;`,
      errors: [error],
    },
    {
      name: "a typed arrow wrapper over a named import",
      code: `import { MAX_MUTATIONS } from "./constants";

export const maxMutations = (): number => MAX_MUTATIONS;`,
      errors: [error],
    },
    {
      name: "an untyped arrow wrapper",
      code: `export const maxMutations = () => MAX_MUTATIONS;`,
      errors: [error],
    },
    {
      // A namespace member is the same second door as a named import of it.
      name: "a typed wrapper over a namespace member",
      code: `import * as C from "./constants";

export function maxMutations(): number {
  return C.MAX_MUTATIONS;
}`,
      errors: [error],
    },
    {
      // TypeScript hoists imports, so an import below the wrapper is the same shim.
      name: "a typed wrapper above its import",
      code: `export function maxMutations(): number {
  return MAX_MUTATIONS;
}

import { MAX_MUTATIONS } from "./constants";`,
      errors: [error],
    },
    {
      name: "a generic wrapper",
      code: `import { DEFAULTS } from "./constants";

export function defaults<T extends Record<string, unknown>>(): T {
  return DEFAULTS;
}`,
      errors: [error],
    },
    {
      name: "a wrapper with an object return type",
      code: `import { SYNC_OPTIONS } from "./constants";

export function syncOptions(): { batch: number; retries?: number } {
  return SYNC_OPTIONS;
}`,
      errors: [error],
    },
    {
      name: "an arrow whose return type holds an arrow",
      code: `import { onIdle } from "./idle";

export const idleHandler = (): (() => void) => onIdle;`,
      errors: [error],
    },
    {
      name: "an arrow typed on the variable",
      code: `import { MAX_MUTATIONS } from "./constants";

export const maxMutations: () => number = () => MAX_MUTATIONS;`,
      errors: [error],
    },
    {
      // The parameter list may hold parens (a function-typed parameter).
      name: "a typed wrapper with a function-typed parameter",
      code: `import { MAX_MUTATIONS } from "./constants";

export function maxMutations(onChange: () => void): number {
  return MAX_MUTATIONS;
}`,
      errors: [error],
    },
    {
      name: "an untyped wrapper with a function-typed parameter",
      code: `export const maxMutations = (onChange: (next: number) => void) => MAX_MUTATIONS;`,
      errors: [error],
    },
    {
      name: "a wrapper with a nested object return type",
      code: `import { SYNC_OPTIONS } from "./constants";

export function syncOptions(): { batch: number; retry: { max: number; delayMs?: number } } {
  return SYNC_OPTIONS;
}`,
      errors: [error],
    },
    {
      name: "a wrapper with function-typed and method members",
      code: `import { IDLE_HANDLERS } from "./idle";

export function idleHandlers(): { get(): number; onIdle: (at: number) => void } {
  return IDLE_HANDLERS;
}`,
      errors: [error],
    },
    {
      // A name inside an initializer call is not a declarator of the `let`.
      name: "an untyped wrapper over a name that a let initializer reads",
      code: `let cache = createCache(store, MAX_ENTRIES);

export function maxEntries() {
  return MAX_ENTRIES;
}`,
      errors: [error],
    },
    {
      // A name in a return-type paren group is not a parameter.
      name: "a typed wrapper whose return type names it in a paren group",
      code: `import { MAX_MUTATIONS } from "./constants";

export function maxMutations(): Parameters<(limit: typeof MAX_MUTATIONS) => void>[0] {
  return MAX_MUTATIONS;
}`,
      errors: [error],
    },
    {
      // A `const` binding cannot change, so a getter over an object literal that
      // the file mentions nowhere else returns the same reference as an export.
      name: "a typed wrapper over an unexported object const",
      code: `const DEFAULTS = { batch: 50, retries: 3 };

export function getDefaults(): Defaults {
  return DEFAULTS;
}`,
      errors: [error],
    },
    {
      // A `typeof` query is a type, not a read of the value.
      name: "a typed arrow over an unexported as-const array",
      code: `const KINDS = ["email", "event"] as const;

export type Kind = (typeof KINDS)[number];

export const kinds = (): readonly Kind[] => KINDS;`,
      errors: [error],
    },
    {
      // The initializer can be a call: the binding still cannot change.
      name: "a typed wrapper over an unexported const with a call initializer",
      code: `export function sharedCache(): Cache {
  return cache;
}

const cache: Cache = createCache({ max: 100 });`,
      errors: [error],
    },
    {
      // A name in a parameter's type is not a parameter.
      name: "a typed wrapper whose parameter type names it",
      code: `import { MAX_MUTATIONS } from "./constants";

export function maxMutations(limit: typeof MAX_MUTATIONS): number {
  return MAX_MUTATIONS;
}`,
      errors: [error],
    },
    {
      name: "a wrapper with an object return type three levels deep",
      code: `import { SYNC_OPTIONS } from "./constants";

export function syncOptions(): { retry: { backoff: { baseMs: number; maxMs?: number } } } {
  return SYNC_OPTIONS;
}`,
      errors: [error],
    },
    {
      // A method member may take a function-typed parameter.
      name: "a wrapper with a method that takes a function-typed parameter",
      code: `import { IDLE_SOURCE } from "./idle";

export function idleSource(): { subscribe(listener: () => void): () => void } {
  return IDLE_SOURCE;
}`,
      errors: [error],
    },
    {
      name: "an arrow whose return type nests parens three levels deep",
      code: `import { onIdle } from "./idle";

export const idleHandler = (): ((cb: (at: number) => void) => void) => onIdle;`,
      errors: [error],
    },
    {
      name: "a wrapper whose parameter list nests three levels deep",
      code: `import { MAX_MUTATIONS } from "./constants";

export function maxMutations(onChange: (next: (n: number) => void) => void): number {
  return MAX_MUTATIONS;
}`,
      errors: [error],
    },
    // ---------------------------------------------------------------------
    // The holes #1377 left open, closed by the AST. Each case below was
    // wrong under the regex rule.
    // ---------------------------------------------------------------------
    {
      // Hole 1: a read is not a change. `KINDS.includes(x)` calls a read-only
      // method, `{ ...DEFAULTS }` is a copy, `typeof` is a type and a comment
      // is not a reference. The regex counted the method call and the trailing
      // comment as mentions, so it missed `kinds`.
      name: "typed getters over consts that the module only reads",
      code: `const KINDS = ["email", "event"];
const DEFAULTS = { batch: 50, retries: 3 };

export type Kind = (typeof KINDS)[number]; // one of KINDS

export function isKind(value: string): boolean {
  return KINDS.includes(value);
}

export function withDefaults(options: Partial<Defaults>): Defaults {
  return { ...DEFAULTS, ...options };
}

export function kinds(): readonly string[] {
  return KINDS;
}

export function getDefaults(): Defaults {
  return DEFAULTS;
}`,
      errors: [error, error],
    },
    {
      // Hole 1: `export { DEFAULTS }` exposes the const. The regex read only
      // `export const`, and it counted the specifier as a mention.
      name: "a typed getter over a const that an export specifier exposes",
      code: `const DEFAULTS = { batch: 50 };

export { DEFAULTS };

export function getDefaults(): Defaults {
  return DEFAULTS;
}`,
      errors: [error],
    },
    {
      // Hole 2: the return of one exported getter is not a change for the
      // other. In the regex each getter mentioned the const for the other.
      name: "two getters over one const",
      code: `const LIMITS = { batch: 50 };

export function limits(): Limits {
  return LIMITS;
}

export const currentLimits = (): Limits => LIMITS;`,
      errors: [error, error],
    },
    {
      // Hole 3: a later declarator is a binding of its own.
      name: "a typed getter over the second declarator of a const",
      code: `const VERSION = 1,
  DEFAULTS = { batch: 50 };

export function getDefaults(): Defaults {
  return DEFAULTS;
}`,
      errors: [error],
    },
    {
      // Hole 4: a parameter list four paren levels deep.
      name: "a wrapper whose parameter list nests four levels deep",
      code: `import { MAX_MUTATIONS } from "./constants";

export function maxMutations(onChange: (a: (b: (n: number) => void) => void) => void): number {
  return MAX_MUTATIONS;
}`,
      errors: [error],
    },
    {
      // Hole 4: an object return type four brace levels deep.
      name: "a wrapper with an object return type four levels deep",
      code: `import { SYNC_OPTIONS } from "./constants";

export function syncOptions(): { retry: { backoff: { jitter: { ratio: number } } } } {
  return SYNC_OPTIONS;
}`,
      errors: [error],
    },
    {
      // Hole 4: an arrow return type four paren levels deep.
      name: "an arrow whose return type nests parens four levels deep",
      code: `import { onIdle } from "./idle";

export const idleHandler = (): ((a: (b: (n: number) => void) => void) => void) => onIdle;`,
      errors: [error],
    },
    {
      // Hole 5: a name in a parameter's object type is not a binding.
      name: "a typed wrapper whose parameter's object type names it",
      code: `import { MAX_MUTATIONS } from "./constants";

export function maxMutations(options: { MAX_MUTATIONS: number }): number {
  return MAX_MUTATIONS;
}`,
      errors: [error],
    },
    {
      // Hole 5: a destructured key is not a binding. `{ MAX_MUTATIONS: limit }`
      // binds `limit`.
      name: "a typed wrapper whose destructured key names it",
      code: `import { MAX_MUTATIONS } from "./constants";

export function maxMutations({ MAX_MUTATIONS: limit }: Options): number {
  return MAX_MUTATIONS;
}`,
      errors: [error],
    },
    {
      // Hole 6: a name inside a `let` initializer is not a declarator.
      name: "an untyped wrapper over a name that a let initializer passes on",
      code: `let cache = createCache(store, MAX_ENTRIES, ttl);

export function maxEntries() {
  return MAX_ENTRIES;
}`,
      errors: [error],
    },
  ],
});
