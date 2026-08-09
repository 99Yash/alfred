/**
 * The one boot-seam idiom every tool-runtime adapter shares: a slot the
 * composition root installs once at boot, a peer reads, and a disposer that
 * clears only the value it installed. Before this factory each seam hand-rolled
 * the same four parts — a module-level `let`, an identity-guarded install, a
 * throw-when-empty read, and an identity-scoped disposer — and stayed correct
 * only by copying a sibling. One copy that guarded with `if (current) throw`
 * instead of the identity check shipped CI-red. `bootPort` writes the guard
 * once, so a future seam calls the factory and cannot write the wrong one.
 */

export interface BootPort<T> {
  /**
   * The composition root fills the slot once at boot. Installing the same
   * instance again is a no-op, so a repeat boot call in one process does not
   * throw. Installing a different value while the slot is full throws. Returns a
   * disposer that clears the slot only while it still holds this exact value.
   */
  install(value: T): () => void;
  /** A peer reads the installed value, or throws when the slot is empty. */
  read(): T;
}

export function bootPort<T>(label: string): BootPort<T> {
  let current: T | undefined;
  return {
    install(value: T): () => void {
      if (current !== undefined && current !== value) {
        throw new Error(`A ${label} is already registered`);
      }
      current = value;
      return () => {
        if (current === value) current = undefined;
      };
    },
    read(): T {
      if (current === undefined) throw new Error(`No ${label} is registered`);
      return current;
    },
  };
}
