/**
 * Runtime type guards for narrowing `unknown` / `object` values safely.
 *
 * The motivating case: code that digs into loosely-typed payloads — provider
 * metadata, parsed JSON blobs, webhook bodies — kept reaching for
 *
 *   if (x && typeof x === "object") (x as Record<string, unknown>).foo
 *
 * `typeof x === "object"` is `true` for arrays AND for `null`, so that cast
 * asserts a shape nothing actually checked: `.foo` on an array reads a
 * surprising index, and the chain blows up the moment a level is missing. The
 * guards below do the real check once, in one place, and the `getPath` walker
 * collapses the nested-cast ladder into a single call that never throws.
 */

/**
 * True only for plain object records — not `null`, arrays, Date, Map, or class
 * instances. This is the narrowing most `typeof x === "object"` checks meant:
 * after it, indexing a key yields `unknown` (which you then narrow), and exotic
 * objects are excluded instead of being silently treated as JSON.
 *
 * This is a BOUNDARY guard. It exists for values that are genuinely `unknown` —
 * unparsed JSON, a webhook body, a jsonb column with no type claim, a provider
 * trace. Do not apply it to a value whose type a schema or row type already
 * established: it widens the parsed shape back to `Record<string, unknown>` and
 * erases the parse. If the field you want is typed, index it directly.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Alias for call sites where the plain-object requirement is the point being documented. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

/**
 * True for any non-null *reference* value — a plain object, array, `Date`,
 * `Map`, class instance, driver error, or function. Put differently: anything
 * you can safely read a property off of; primitives and `null` are the only
 * things it rejects.
 *
 * This is the deliberately permissive counterpart to {@link isRecord}, and the
 * two answer different questions. Use `isRecord` when you need a plain JSON
 * object and want arrays, dates, and class instances rejected. Use
 * `isIndexable` when the value is a *runtime* object you only mean to pull a
 * field off — a caught error whose `.code`/`.cause` you're inspecting, an SDK
 * instance, a Postgres `DatabaseError` — where `isRecord` would wrongly reject
 * the very thing you're holding.
 *
 * The `|| typeof === "function"` arm matters because functions are objects you
 * can index too, and `typeof null === "object"` is why the explicit `!== null`
 * is required. Narrows to `object`, which is exactly what `Reflect.get`
 * accepts, so the follow-up read needs no cast:
 *
 *   if (!isIndexable(err)) return undefined;
 *   const code = Reflect.get(err, "code"); // `code` is `unknown` — narrow it
 */
export function isIndexable(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

/** True for a usable string — the common "present and non-empty" check. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * True for a 1-indexed positive integer — the provenance constraint for PDF
 * page anchors. Extractors produce these; models must not assert them. Use
 * this guard at every boundary that receives a page value from `unknown`
 * (metadata, JSON, provider output) to replace the repeated
 * `typeof x === "number" && Number.isInteger(x) && x >= 1` check.
 */
export function isValidPage(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * Coerce an `unknown` (typically a nullable `jsonb` column) to a record,
 * falling back to an empty object when it isn't one. Replaces the repeated
 * `(x as Record<string, unknown> | null) ?? {}` — which lied for arrays and
 * primitives — with a check that actually holds: the result is always a real
 * record, so reading keys off it is sound.
 */
export function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Coerce an `unknown` to a `string[]`, dropping any non-string elements and
 * yielding `[]` when the value isn't an array. Replaces
 * `Array.isArray(x) ? (x as string[]) : []` — which asserted the element type
 * without checking it — with a coercion that actually holds at runtime.
 */
export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Walk a chain of object keys through an `unknown` value, returning whatever
 * sits at the end — or `undefined` if any link along the way isn't a record
 * or the key is absent. Never throws.
 *
 * The result is deliberately `unknown`: narrow it at the leaf with the guard
 * that matches what you expect (`isRecord`, `Array.isArray`, `isNonEmptyString`,
 * …). This replaces the repeated "check object → cast to Record → index →
 * check object → cast → index" ladder with one expression:
 *
 *   const chunks = getPath(meta, "google", "groundingMetadata", "groundingChunks");
 *   if (Array.isArray(chunks)) { ... }
 */
export function getPath(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Typed leaf reader for the common "walk JSON, then accept only a string"
 * pattern. Keep `getPath` for non-string leaves; use this when the caller would
 * otherwise immediately write `typeof leaf === "string" ? leaf : undefined`.
 */
export function getStringPath(value: unknown, ...keys: string[]): string | undefined {
  const leaf = getPath(value, ...keys);
  return typeof leaf === "string" ? leaf : undefined;
}

/**
 * Build a membership guard for a fixed set of string literals — the
 * `typeof value === "string" && (TUPLE as readonly string[]).includes(value)`
 * boilerplate that was hand-copied onto every wire enum. Pass the `as const`
 * tuple that already defines the enum and get back the guard that narrows to its
 * member union, so the tuple stays the single source of truth: the type
 * (`typeof TUPLE[number]`), a `z.enum(TUPLE)` where parsing is needed, and this
 * guard are three projections of one declaration rather than parallel shapes.
 *
 * Accepts `unknown` (the `typeof` check makes the raw `.has` sound), so it
 * covers both the persisted-value guards and the already-`string` slug guards.
 * The lookup set is built once when the guard is created, not per call.
 *
 *   export const isToolRiskTier = enumGuard(TOOL_RISK_TIERS);
 *   // (value: unknown) => value is ToolRiskTier
 */
export function enumGuard<const T extends readonly string[]>(
  values: T,
): (value: unknown) => value is T[number] {
  const members: ReadonlySet<string> = new Set(values);
  return (value): value is T[number] => typeof value === "string" && members.has(value);
}

/**
 * Pull the bare lowercase `local@domain` out of a `From:`-style header,
 * unwrapping a `"Display Name <addr>"` form when present and dropping anything
 * with no `@`. Returns `null` for empty/garbage input.
 *
 * The single source of truth for self-mail matching (issue #211): the Gmail
 * ingestion guard (`isSelfAuthored`) and the self-mail retirement backfill both
 * route through this so they match exactly the same set — display-name-aware,
 * exact-address, never a substring of display text. Keep behaviour pinned: a
 * change here silently widens or narrows what gets dropped/retired.
 */
export function parseEmailAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
  return raw.includes("@") ? raw : null;
}

/**
 * Merge caller overrides onto a full defaults object, ignoring any key whose
 * override value is `undefined`. The one way to resolve a `Partial<T>` of
 * tunables or injected dependencies against its defaults.
 *
 * This exists because the plain spread it replaces has a silent failure mode:
 *
 *   const policy = { ...DEFAULT_POLICY, ...options.policy }; // maxAttempts: undefined
 *
 * A *present* `undefined` wins a spread, so one explicitly-undefined key zeroes
 * the default it was supposed to fall back to — here `maxAttempts` becomes
 * `undefined`, the retry loop's `attempt <= policy.maxAttempts` is `false`, and
 * the request is never sent. Nothing throws; the behaviour just quietly
 * disappears.
 *
 * `exactOptionalPropertyTypes` catches that at any call site whose type is
 * narrow (`{ k?: T }`, which `Partial<T>` is), which is why the tree was safe
 * when this helper was written. But it made *narrowness itself* load-bearing:
 * widening one declaration to `k?: T | undefined` — the correct move nearly
 * everywhere else, since absence and present-undefined usually mean the same
 * thing — would silently re-open the hole here, with nothing at the defaults
 * site saying so. Routing the merge through this function makes the declaration
 * spelling a comprehension choice again rather than a correctness guard.
 *
 * Iterates the override keys (not the defaults'), so it stays faithful to spread
 * semantics when `defaults` doesn't enumerate every key of `T`.
 *
 * The override parameter is deliberately the WIDE partial (`T[K] | undefined`)
 * rather than `Partial<T>`, which is narrow under `exactOptionalPropertyTypes`.
 * Tolerating a present `undefined` is the entire contract, so the signature has
 * to admit one — and the shapes most in need of this helper are the already
 * widened ones (`AttributedCall`, whose every field is `| undefined`, so the
 * flag catches nothing there), which a `Partial<T>` parameter would reject.
 */
export function withDefaults<T extends object>(
  defaults: T,
  overrides?: { [K in keyof T]?: T[K] | undefined },
): T {
  const merged = { ...defaults };
  if (!overrides) return merged;
  // `Object.keys` is typed `string[]`; the value is a `Partial<T>`, so its keys
  // are `keyof T` by construction. The read below is what needs the key type.
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const value = overrides[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}
