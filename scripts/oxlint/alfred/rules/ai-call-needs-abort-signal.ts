import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { passThrough, resolveName } from "../shared/module-bindings.ts";
import { inGateScope } from "../shared/scope.ts";

/**
 * `ai-call-needs-abort-signal`: an AI SDK generate or stream call names an
 * `abortSignal` in its options.
 *
 * The metered wrappers in `@alfred/ai` set a 600 s `timeout` when the caller
 * sets none, so no call hangs forever. That backstop is not a cancel path: a
 * caller that stops waiting (a stopped turn, a job past its deadline, a lost
 * sibling) keeps a billable call open until the model ends it. Found in PRs
 * #1086, #714, #1111 and #1133. See
 * `docs/reference/smells/external-call-timeout-and-abort.md`.
 *
 * What it flags. A call to one of {@link AI_CALLEES}, bare or as a member
 * (`ai.generateText`), whose first argument shows no `abortSignal` key. The
 * rule reads the key in:
 * - the object literal itself, as a property or a shorthand;
 * - an object literal that a spread expands, also through `?:`, `&&`, `||`
 *   and `??` (`...(signal ? { abortSignal: signal } : {})`);
 * - a `const` in the same file whose initializer is one of these.
 * Parentheses, `as`, `satisfies` and `!` are read through.
 *
 * Opaque options. A spread or an argument that the rule cannot read (a
 * parameter, a call result, a member, a `let`, a destructured name) can carry
 * the key or not. The rule reports it with its own message, unless a visible
 * `abortSignal` key is also present. A pass-through wrapper that forwards the
 * caller's options puts a disable comment on the call with the reason.
 *
 * What it does not check. The value of the key: an `abortSignal` that is
 * `undefined` at run time passes, and so does a conditional key that is
 * absent at run time. Whether the signal also has a timeout. A call through an
 * alias (`const g = generateText`), `.call`/`.apply`, or a wrapper with another
 * name (`AlfredAgent#turn`). The second sentence of the smell, which cancels
 * the siblings of a `Promise.all`, stays with review.
 *
 * File scope. The consolidation gate's scope (`inGateScope`). Scripts, smokes,
 * probes and evals are out: an operator runs them and stops them with Ctrl-C.
 */

const AI_CALLEES: ReadonlySet<string> = new Set([
  "generateObject",
  "generateText",
  "meteredGenerateObject",
  "meteredGenerateText",
  "meteredStreamText",
  "streamObject",
  "streamText",
]);

/** What the rule can see of an options value. */
type Verdict = "present" | "absent" | "opaque";

function calleeName(node: ESTree.CallExpression): string | null {
  const { callee } = node;

  if (callee.type === "Identifier") return callee.name;

  if (callee.type === "MemberExpression" && !callee.computed) {
    return callee.property.type === "Identifier" ? callee.property.name : null;
  }

  return null;
}

function isAbortSignalKey(property: ESTree.ObjectProperty): boolean {
  const { key } = property;

  if (!property.computed && key.type === "Identifier") return key.name === "abortSignal";

  return key.type === "Literal" && key.value === "abortSignal";
}

/** The best of several verdicts: one visible key is enough. */
function anyOf(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("present")) return "present";

  return verdicts.includes("opaque") ? "opaque" : "absent";
}

/** The initializer of the `const` that binds `variable`, or null. */
function constInitOf(variable: Variable): ESTree.Expression | null {
  for (const definition of variable.defs) {
    if (
      definition.type === "Variable" &&
      definition.node.type === "VariableDeclarator" &&
      definition.node.id.type === "Identifier" &&
      definition.parent?.type === "VariableDeclaration" &&
      definition.parent.kind === "const"
    ) {
      return definition.node.init;
    }
  }

  return null;
}

function propertyVerdict(
  sourceCode: SourceCode,
  property: ESTree.ObjectExpression["properties"][number],
  seen: Set<Variable>,
): Verdict {
  if (property.type === "SpreadElement") return verdictOf(sourceCode, property.argument, seen);

  return isAbortSignalKey(property) ? "present" : "absent";
}

function verdictOf(sourceCode: SourceCode, node: ESTree.Node, seen: Set<Variable>): Verdict {
  const value = passThrough(node);

  if (value.type === "ObjectExpression") {
    return anyOf(value.properties.map((property) => propertyVerdict(sourceCode, property, seen)));
  }

  if (value.type === "ConditionalExpression") {
    return anyOf([
      verdictOf(sourceCode, value.consequent, seen),
      verdictOf(sourceCode, value.alternate, seen),
    ]);
  }

  if (value.type === "LogicalExpression") {
    return anyOf([
      verdictOf(sourceCode, value.left, seen),
      verdictOf(sourceCode, value.right, seen),
    ]);
  }

  // A spread of a falsy value adds no key: `...(cond && { abortSignal })`.
  if (value.type === "Literal") return "absent";

  if (value.type !== "Identifier") return "opaque";

  const variable = resolveName(sourceCode, value);

  if (variable === null || seen.has(variable)) return "opaque";
  seen.add(variable);
  const init = constInitOf(variable);

  return init === null ? "opaque" : verdictOf(sourceCode, init, seen);
}

export const aiCallNeedsAbortSignalRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require an `abortSignal` key in the options of an AI SDK generate or stream call.",
    },
    messages: {
      missingAbortSignal:
        "This model call has no `abortSignal`, so a caller that stops waiting keeps a billable call open. Pass the caller's run, request or job signal, combined with `AbortSignal.timeout(MS)` (`AbortSignal.any([...])`) when both exist, or `AbortSignal.timeout(MS)` alone when no parent signal exists.",
      opaqueOptions:
        "The options come from a value that this rule cannot read, so it cannot see an `abortSignal`. Write the `abortSignal` key in the call, or disable this line with the reason that the signal travels in the forwarded options.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return inGateScope(context.filename, context.cwd);
      },
      CallExpression(node) {
        const name = calleeName(node);

        if (name === null || !AI_CALLEES.has(name)) return;

        if (node.arguments.length === 0) return;

        const options = node.arguments[0];

        const verdict: Verdict =
          options.type === "SpreadElement"
            ? "opaque"
            : verdictOf(context.sourceCode, options, new Set());

        if (verdict === "absent") {
          context.report({ node: node.callee, messageId: "missingAbortSignal" });
        } else if (verdict === "opaque") {
          context.report({ node: node.callee, messageId: "opaqueOptions" });
        }
      },
    };
  },
});
