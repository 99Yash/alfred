import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authoredMotionViolations,
  slideArtifactHtmlViolations,
  validatePdfArtifactHtml,
  validateSlideArtifactHtml,
} from "@alfred/artifacts-design/validation";
import { buildArtifactDocument, MOTION_CLASS_NAMES } from "@alfred/artifacts-design/shell";

/* ── motion rejection (ADR-0086 safety floor) — pure, always run ────────────
 *
 * The shell owns one central print/reduced-motion guard that snaps its own
 * motion classes to their resting frame. An AUTHORED @keyframes/animation has
 * no such guard and can freeze content hidden, so the write boundary rejects it
 * for both slides and pdf. Shell-class motion (art-rise, art-drift, …) is
 * applied via class= and never appears in an authored style source, so it is
 * always allowed.
 */

test("authored @keyframes is a motion violation", () => {
  const html = `<div class="art-page"><style>@keyframes spin { to { transform: rotate(360deg); } }</style></div>`;
  assert.deepEqual(authoredMotionViolations(html), ["authored-keyframes"]);
});

test("vendor-prefixed @keyframes is rejected too", () => {
  const html = `<style>@-webkit-keyframes fade { from { opacity: 0; } }</style>`;
  assert.ok(authoredMotionViolations(html).includes("authored-keyframes"));
});

test("an animation shorthand in an inline style is a motion violation", () => {
  const html = `<div style="animation: fade 1s ease both">x</div>`;
  assert.deepEqual(authoredMotionViolations(html), ["authored-animation"]);
});

test("an animation-* longhand is a motion violation", () => {
  const html = `<style>.x { animation-delay: 0.2s; }</style>`;
  assert.deepEqual(authoredMotionViolations(html), ["authored-animation"]);
});

test("a custom property named --my-animation is NOT flagged (declaration boundary)", () => {
  const html = `<style>.x { --my-animation: none; color: var(--art-ink); }</style>`;
  assert.deepEqual(authoredMotionViolations(html), []);
});

test("a transition is allowed (it cannot fire in a static sandbox)", () => {
  const html = `<div style="transition: opacity 0.3s ease">x</div>`;
  assert.deepEqual(authoredMotionViolations(html), []);
});

test("prose that merely mentions animation: in text is not flagged", () => {
  const html = `<p class="art-body">The CSS animation: property drives motion.</p>`;
  assert.deepEqual(authoredMotionViolations(html), []);
});

test("shell motion applied via class= is allowed (no authored style source)", () => {
  const html = `<div class="art-stagger art-stack"><h1 class="art-display art-rise">Hi</h1></div>`;
  assert.deepEqual(authoredMotionViolations(html), []);
});

test("validateSlideArtifactHtml rejects authored animation and accepts clean HTML", () => {
  assert.equal(validateSlideArtifactHtml(`<div style="animation: x 1s">a</div>`).ok, false);
  assert.equal(
    validateSlideArtifactHtml(
      `<div class="art-center art-rise"><h1 class="art-display">A</h1></div>`,
    ).ok,
    true,
  );
});

test("slideArtifactHtmlViolations checks motion ONLY (no font/root rules)", () => {
  // A slide with a custom font-size + no art-doc root is fine — slides keep
  // inline-geometry freedom; only motion is enforced for them.
  const html = `<div style="font-size: 90px; animation: none">A</div>`;
  // font-size is not a slide violation; `animation: none` IS (still authored).
  assert.deepEqual(slideArtifactHtmlViolations(html), ["authored-animation"]);
});

test("validatePdfArtifactHtml still enforces the document contract", () => {
  // No art-doc root -> document-contract violation.
  assert.equal(validatePdfArtifactHtml(`<div class="art-stack">no doc root</div>`).ok, false);
});

test("validatePdfArtifactHtml rejects authored motion alongside the doc contract", () => {
  const html = `<div class="art-doc"><style>@keyframes k { to { opacity: 1; } }</style></div>`;
  const result = validatePdfArtifactHtml(html);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /authored-keyframes/);
});

test("a clean art-doc page passes the pdf contract", () => {
  const html = `<div class="art-doc"><div class="art-doc-header"><div class="art-doc-name">A</div></div></div>`;
  assert.equal(validatePdfArtifactHtml(html).ok, true);
});

/* ── motion vocabulary is one source of truth ───────────────────────────────
 *
 * MOTION_CLASS_NAMES is the single list the rejection hint reads. Every name in
 * it must render as a real selector in the shell CSS, or the hint would advertise
 * a class authors cannot use — the `art-draw` phantom this guard replaced. These
 * two tests pin both directions so the hint and the shell can never drift apart.
 */

test("every MOTION_CLASS_NAMES entry renders as a real shell selector", () => {
  const shell = buildArtifactDocument("<div></div>", "slides");
  for (const name of MOTION_CLASS_NAMES) {
    assert.ok(shell.includes(`.${name}`), `shell CSS is missing a .${name} selector`);
  }
});

test("the motion rejection hint names exactly the shell motion classes (no phantoms)", () => {
  const result = validateSlideArtifactHtml(`<div style="animation: x 1s">a</div>`);
  assert.equal(result.ok, false);
  if (!result.ok) {
    for (const name of MOTION_CLASS_NAMES) {
      assert.ok(result.reason.includes(name), `hint should name ${name}`);
    }
    // The retired phantom must never come back into the advertised set.
    assert.ok(!result.reason.includes("art-draw"), "hint must not advertise the removed art-draw");
  }
});
