import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isFunctionNode } from "../shared/function-node.ts";
import { inGateScope } from "../shared/scope.ts";

/**
 * `log-caught-error-under-err`: a caught error reaches a `logger` call only as
 * the raw value under the `err` key.
 *
 * `@alfred/logging` registers its redacting serializer (`serializeError`) for
 * the `err` key only. In production that serializer drops `message`, `url` and
 * `responseBody`. Every other key goes through pino's JSON stringify, which
 * writes the text as it is, so an error message there can carry a connection
 * string or a token. A string under `err` is no better: the serializer reads
 * it as `{"type":"string"}`, and the diagnostic is gone. Found in PRs #1297,
 * #1303, #1307 and #1111. See `docs/reference/smells/log-caught-error-under-err.md`.
 *
 * What it flags. A reference to a catch binding, in a `logger.<level>(…)`
 * call, that is one of these:
 * - the binding, its `.message`, `.stack` or `.cause`, or a call or template
 *   that takes them, under a key that is not `err`;
 * - such a derived value under `err`, for example `err: toMessage(err)`;
 * - any of them in the message argument.
 * A catch binding is the parameter of a `catch` clause or of the callback of
 * a `.catch(…)` call.
 *
 * What it skips. `safeErrorDiagnostic(err)` under any key: it is the safe text
 * form of a fault. A read of another field, such as `err.code`. A test of the
 * error, such as `err instanceof AppError`. The raw binding as the first
 * argument, which pino logs as `err`.
 *
 * What it does not see. A logger under a name other than `logger`, a binding
 * copied into another variable first, and a message that a helper builds
 * outside the call.
 *
 * File scope. The consolidation gate's scope (`inGateScope`).
 */

const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

/** The fields of an error that hold its free text. */
const TEXT_FIELDS = new Set(["message", "stack", "cause"]);

const SAFE_DIAGNOSTIC = "safeErrorDiagnostic";

function isLoggerCall(node: ESTree.Node): node is ESTree.CallExpression {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return false;

  const { object, property, computed } = node.callee;

  if (computed || property.type !== "Identifier" || !LOG_LEVELS.has(property.name)) return false;

  return (
    (object.type === "Identifier" && object.name === "logger") ||
    (object.type === "MemberExpression" &&
      !object.computed &&
      object.property.type === "Identifier" &&
      object.property.name === "logger")
  );
}

function isErrKey(property: ESTree.ObjectProperty): boolean {
  if (property.computed) return false;

  const { key } = property;

  return (
    (key.type === "Identifier" && key.name === "err") ||
    (key.type === "Literal" && key.value === "err")
  );
}

type Finding = "notUnderErr" | "errNotRaw";

/**
 * Walks up from one reference to the catch binding. Returns a finding when
 * the reference reaches a `logger` call in a form that the serializer does not
 * see, and `null` when it stops first.
 */
function findingFor(reference: ESTree.Node): Finding | null {
  const path: ESTree.Node[] = [];
  let current: ESTree.Node = reference;

  for (;;) {
    const parent: ESTree.Node | null | undefined = current.parent;

    if (!parent || isFunctionNode(parent) || parent.type.endsWith("Statement")) return null;

    if (parent.type === "MemberExpression" && parent.object === current) {
      const field =
        !parent.computed && parent.property.type === "Identifier" ? parent.property.name : null;

      if (field === null || !TEXT_FIELDS.has(field)) return null;
    }

    if (
      parent.type === "CallExpression" &&
      parent.callee.type === "Identifier" &&
      parent.callee.name === SAFE_DIAGNOSTIC
    ) {
      return null;
    }

    // A test of the error (`err instanceof X`, `err === null`, `typeof err`) yields no text.
    if (parent.type === "BinaryExpression" && parent.operator !== "+") return null;

    if (parent.type === "UnaryExpression") return null;

    if (parent.type === "ConditionalExpression" && parent.test === current) return null;

    if (isLoggerCall(parent)) {
      const first = parent.arguments.at(0);

      if (current !== first) return "notUnderErr";

      if (current === reference) return null;

      if (first.type !== "ObjectExpression") return "notUnderErr";

      const property = path.find(
        (node): node is ESTree.ObjectProperty => node.type === "Property" && node.parent === first,
      );

      if (!property) return null;

      if (!isErrKey(property)) return "notUnderErr";

      return property.value === reference ? null : "errNotRaw";
    }

    path.push(parent);
    current = parent;
  }
}

export const logCaughtErrorUnderErrRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject a caught error, or its message, in a `logger` call anywhere but as the raw value under `err`.",
    },
    messages: {
      notUnderErr:
        "Only the `err` key goes through the redacting serializer, so this text reaches the log as it is. Log the raw error as `{ err }`, or use `safeErrorDiagnostic(err)` for a text form.",
      errNotRaw:
        "The `err` serializer reads an error object. A string or a message here loses the diagnostic. Pass the raw caught error: `{ err }`.",
    },
  },
  createOnce(context) {
    function checkBinding(declaration: ESTree.Node, name: string) {
      for (const variable of context.sourceCode.getDeclaredVariables(declaration)) {
        if (variable.name !== name) continue;

        for (const { identifier } of variable.references) {
          const finding = findingFor(identifier);

          if (finding) context.report({ node: identifier, messageId: finding });
        }
      }
    }

    return {
      before() {
        return inGateScope(context.filename, context.cwd);
      },
      CatchClause(node) {
        if (node.param?.type === "Identifier") checkBinding(node, node.param.name);
      },
      CallExpression(node) {
        const { callee } = node;

        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "catch"
        ) {
          return;
        }

        const handler = node.arguments.at(0);

        if (
          handler !== undefined &&
          (handler.type === "ArrowFunctionExpression" || handler.type === "FunctionExpression") &&
          handler.params[0]?.type === "Identifier"
        ) {
          checkBinding(handler, handler.params[0].name);
        }
      },
    };
  },
});
