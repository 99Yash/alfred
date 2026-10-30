import { relative, sep } from "node:path";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isStringLiteral } from "../shared/class-tokens.ts";
import { inGateScope } from "../shared/scope.ts";

/**
 * `no-dash-in-web-copy`: web source holds no em dash (U+2014) or en dash
 * (U+2013) in a string, a template literal or JSX text.
 *
 * The owner's copy voice is short declaratives with no em or en dash. The
 * campaign `chat-dimension-port-20261023` made it a rule for UI copy, and the
 * review of its item 07 found a dash in preview copy that a rewrite had kept.
 * That review proposed this check. The fix ends the sentence with a period,
 * or uses a colon or a comma. A range reads `to` or takes a hyphen. An empty
 * placeholder names the absence.
 *
 * What it flags. A string literal, a static part of a template literal, or a
 * JSX text node whose value holds `—` or `–`, an escape such as `\u2014`
 * included.
 *
 * What it skips. Comments, which are not copy. A module specifier. A string
 * that only a developer reads (a log line, an internal reason) is copy too
 * here: the rule cannot tell where a string ends up, and a plain colon costs
 * nothing.
 *
 * File scope. The consolidation gate's scope (`inGateScope`), less every
 * workspace other than `apps/web`. The voice rule is for the web product;
 * server prompts and mail have their own owners. A file outside the repo tree,
 * such as the `pnpm check:oxlint-plugin` probe, stays in scope.
 */

const DASHES = /[\u2013\u2014]/;

/** True for a file in the gate scope that is not in a workspace other than `apps/web`. */
function inWebScope(filename: string, cwd: string): boolean {
  if (!inGateScope(filename, cwd)) return false;
  const file = relative(cwd, filename).split(sep).join("/");

  return !/^(?:packages\/|apps\/(?!web\/))/.test(file);
}

/** True for a string that names a module (`import … from "x"`, `export … from "x"`, `import("x")`). */
function isModuleSpecifier(node: ESTree.StringLiteral): boolean {
  const { parent } = node;

  return (
    parent.type === "ImportDeclaration" ||
    parent.type === "ExportNamedDeclaration" ||
    parent.type === "ExportAllDeclaration" ||
    parent.type === "ImportExpression"
  );
}

export const noDashInWebCopyRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Reject an em dash or an en dash in a web string or JSX text.",
    },
    messages: {
      dash: "The copy voice has no em dash (—) or en dash (–). Write short declaratives: end the sentence with a period, or use a colon or a comma. Write a range with `to` or a hyphen.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return inWebScope(context.filename, context.cwd);
      },
      Literal(node) {
        if (isStringLiteral(node) && DASHES.test(node.value) && !isModuleSpecifier(node)) {
          context.report({ node, messageId: "dash" });
        }
      },
      TemplateElement(node) {
        if (DASHES.test(node.value.cooked ?? node.value.raw)) {
          context.report({ node, messageId: "dash" });
        }
      },
      JSXText(node) {
        if (DASHES.test(node.value)) context.report({ node, messageId: "dash" });
      },
    };
  },
});
