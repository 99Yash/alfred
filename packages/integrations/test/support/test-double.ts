/**
 * A partial stand-in typed as the full interface, for a Drizzle database handle.
 * Use it only when the code under test reads the provided members and no others.
 * A member that the code reads but the partial leaves out is `undefined` at runtime.
 *
 * It checks member names, not member types: Drizzle types `update` with a generic table
 * parameter and a deep builder chain, and a fake that records the calls cannot satisfy them.
 */
export function asTestDouble<T>(partial: { readonly [K in keyof T]?: unknown }): T {
  // SAFETY: the precondition above: the code under test reads only the members in `partial`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a test double; the code under test reads only these members
  return partial as T;
}
