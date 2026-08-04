import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { bootPort } from "../../src/modules/tool-runtime/boot-port";

// The factory owns the one identity-guard idiom every boot-seam shares: a slot
// the composition root installs once, a peer reads, and a disposer that clears
// only its own value. These tests pin that contract directly, so a future seam
// inherits it by construction instead of re-copying a sibling's guard.

describe("bootPort factory", () => {
  test("read() on an empty port throws the boot-order error", () => {
    const port = bootPort<{ id: string }>("example port");
    assert.throws(() => port.read(), { message: "No example port is registered" });
  });

  test("install(a) then read() returns a", () => {
    const port = bootPort<{ id: string }>("example port");
    const a = { id: "a" };
    port.install(a);
    assert.equal(port.read(), a);
  });

  test("install(a) twice with the same instance is a no-op and read() still returns a", () => {
    const port = bootPort<{ id: string }>("example port");
    const a = { id: "a" };
    port.install(a);
    assert.doesNotThrow(() => port.install(a));
    assert.equal(port.read(), a);
  });

  test("install(b) over a different a throws and the first value survives", () => {
    const port = bootPort<{ id: string }>("example port");
    const a = { id: "a" };
    const b = { id: "b" };
    port.install(a);
    assert.throws(() => port.install(b), { message: "A example port is already registered" });
    assert.equal(port.read(), a);
  });

  test("the disposer clears the slot and a later read() throws", () => {
    const port = bootPort<{ id: string }>("example port");
    const a = { id: "a" };
    const dispose = port.install(a);
    dispose();
    assert.throws(() => port.read(), { message: "No example port is registered" });
  });

  test("a stale disposer does not clear a value it did not install", () => {
    const port = bootPort<{ id: string }>("example port");
    const a = { id: "a" };
    const b = { id: "b" };
    const disposeA = port.install(a);
    disposeA();
    port.install(b);
    disposeA();
    assert.equal(port.read(), b);
  });
});
