/**
 * A partial stand-in typed as the full interface, for a `tx`, a Replicache transaction, or a promise.
 * Use it only when the code under test reads the provided members and no others.
 * A member that the code reads but the partial leaves out is `undefined` at runtime.
 *
 * It checks member names, not member types: Replicache types `get` and `scan` with generic
 * overloads, and an in-memory fake that stores plain values cannot satisfy them.
 */
export function asTestDouble<T>(partial: { readonly [K in keyof T]?: unknown }): T {
  // SAFETY: the precondition above: the code under test reads only the members in `partial`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a test double; the code under test reads only these members
  return partial as T;
}
