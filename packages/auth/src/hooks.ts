// Post-signup callbacks. The server registers them at boot, since `@alfred/auth` cannot import it.

export type OnUserCreatedHook = (user: { id: string; email: string }) => Promise<void>;

const _hooks: OnUserCreatedHook[] = [];

export function registerOnUserCreated(fn: OnUserCreatedHook): void {
  _hooks.push(fn);
}

export function getOnUserCreatedHooks(): readonly OnUserCreatedHook[] {
  return _hooks;
}

/** Test-only: clear all registered hooks. */
export function _resetOnUserCreatedHooksForTests(): void {
  _hooks.length = 0;
}
