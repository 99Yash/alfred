/** A slot the composition root fills once at boot and a peer reads. */

export interface BootPort<T> {
  /**
   * Same value again is a no-op; a different value throws. The disposer clears
   * the slot only while it still holds this value.
   */
  install(value: T): () => void;
  /** Throws when the slot is empty. */
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
