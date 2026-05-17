/**
 * Post-signup hook registration. The auth instance lives in
 * `@alfred/auth`, which cannot depend on `@alfred/api` (cycle). Instead,
 * downstream code (the server bootstrap) registers callbacks here at
 * boot, and `auth()`'s `databaseHooks.user.create.after` invokes them.
 *
 * Today there's one callback (workflow row seeding); other downstream
 * concerns — analytics, welcome emails, etc. — can stack on top.
 *
 * Hooks must be registered before the first signup completes. Errors
 * thrown inside a hook are caught + logged by `auth()` so a failing
 * downstream subsystem doesn't bounce a legitimate signup.
 */

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
