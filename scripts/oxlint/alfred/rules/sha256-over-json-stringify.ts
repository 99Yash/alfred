import { defineRule } from "@oxlint/plugins";

import type { ESTree, Reference, Scope, SourceCode, Variable } from "@oxlint/plugins";

import { inGateScope } from "../shared/scope.ts";

// A content hash whose pre-image is `JSON.stringify` output depends on object key
// INSERTION order. Three copies fed the `observations` dedup index
// `(user_id, family_key, evidence_hash)` (#571): the same logical payload built along
// two code paths hashed differently, so dedup silently missed and an append-only log
// double-counted. `sha256Canonical` is the fix.
//
// Sinks. The rule reads the value a hash is computed over at three sinks:
// - `createHash(…).update(data)`, also a later `.update(data)` in the same chain;
// - `h.update(data)`, where `h` resolves to a binding whose value is a hasher. A
//   receiver that is not a hasher (Drizzle `db.update(table)`, a cache entry) is
//   never a sink;
// - `subtle.digest(alg, data)` and `crypto.subtle.digest(alg, data)`.
// Any algorithm counts (`md5`, `sha1`, a variable): the bug is the key-order
// pre-image, not the digest. `createHmac` is not a sink: a MAC is checked over the
// bytes that came with it, and `sha256Canonical` takes no key.
//
// JSON. `data` carries JSON when a `JSON.stringify(…)` call sits anywhere inside it
// (joined into a template or a `+`, inside an array or object literal, an argument of
// another call, an encoder, `Buffer.from`), or when a name inside it resolves to a
// binding whose value carries JSON. Names resolve through scope analysis, so a
// parameter, a destructured binding, a `catch` binding or an inner callback parameter
// of the same name is its own binding and never inherits another one.
//
// Value of a binding:
// - `const`: its initializer.
// - `let` / `var`: the writes that reach the use. Walk the plain writes above the use,
//   nearest first, and stop at the first one that always runs before it: a statement
//   in a block that holds the use, in the same function. So `bytes = raw` on its own
//   line hides an earlier JSON value, and `if (x) bytes = raw` does not. A compound
//   write (`+=`, `??=`) adds its value and does not stop the walk. A destructuring or
//   loop write stops the walk with no value. A write below the use is not read, also
//   in a loop.
// - Anything else (parameter, import, `catch`, function, class) has no value. A
//   function-valued binding is not followed: a helper that holds JSON in its body is
//   not the value of a call to it.
//
// Same-file helper. When `data` reaches a plain parameter of a named function in this
// file (`function hashOf(s) { … update(s) … }`, or a `const` arrow), each call of that
// function in this file is read, and an argument in that slot that carries JSON is
// reported at the call. A helper in another file is out of reach of a one-file rule.

type Ranged = Readonly<{ start: number; end: number }>;

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

type Sink = {
  readonly call: ESTree.CallExpression;
  readonly data: ESTree.Expression;
  /** The `.update` receiver, which must be a hasher. Null for `subtle.digest`. */
  readonly receiver: ESTree.Expression | null;
};

type Flow = { json: boolean; readonly params: Variable[] };

type ParameterSlot = { readonly fn: FunctionNode; readonly index: number };

type Write = {
  readonly value: ESTree.Expression | null;
  /** True when the write keeps the earlier value (`+=`, `??=`). */
  readonly keepsEarlier: boolean;
  /** The statement that holds the write, when the write is the whole statement. */
  readonly statement: ESTree.Node | null;
};

const FIX =
  "Use sha256Canonical(value) from @alfred/db/hash — SHA-256 over canonicalJson (keys sorted, present-undefined skipped), prefixed `sha256:`. It is the one content hash for observations.evidence_hash and every other dedup / change-detection digest. In browser code, where @alfred/db is out of reach, encode canonicalJson(value) from @alfred/contracts for crypto.subtle.digest in place of JSON.stringify. If the digest is audit-only and never compared, add `// oxlint-disable-next-line alfred/sha256-over-json-stringify -- <why order-dependence is safe here>`.";

const within = (inner: Ranged, outer: Ranged): boolean =>
  inner.start >= outer.start && inner.end <= outer.end;

function unwrap(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;

  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "ChainExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }

  return current;
}

/** `object.name`, read only when `name` is a plain property name. */
function staticMember(
  expression: ESTree.Expression,
): { readonly object: ESTree.Expression; readonly name: string } | null {
  if (expression.type !== "MemberExpression" || expression.computed) return null;

  if (expression.property.type !== "Identifier") return null;

  return { object: expression.object, name: expression.property.name };
}

function isJsonStringify(call: ESTree.CallExpression): boolean {
  const member = staticMember(call.callee);

  return (
    member !== null &&
    member.name === "stringify" &&
    member.object.type === "Identifier" &&
    member.object.name === "JSON"
  );
}

function isCreateHash(callee: ESTree.Expression): boolean {
  if (callee.type === "Identifier") return callee.name === "createHash";

  return staticMember(callee)?.name === "createHash";
}

/** `subtle`, `crypto.subtle`, `globalThis.crypto.subtle`. */
function isSubtle(expression: ESTree.Expression): boolean {
  if (expression.type === "Identifier") return expression.name === "subtle";

  return staticMember(expression)?.name === "subtle";
}

function sinkOf(call: ESTree.CallExpression): Sink | null {
  const member = staticMember(call.callee);

  if (member === null) return null;

  const [first, second] = call.arguments;

  if (member.name === "update" && first !== undefined && first.type !== "SpreadElement") {
    return { call, data: first, receiver: member.object };
  }

  if (
    member.name === "digest" &&
    isSubtle(member.object) &&
    second !== undefined &&
    second.type !== "SpreadElement"
  ) {
    return { call, data: second, receiver: null };
  }

  return null;
}

function isFunctionNode(node: ESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** One file's analysis. Built at `Program:exit`, only when the file has a sink. */
function analyzeFile(sourceCode: SourceCode, sinks: readonly Sink[], jsonCalls: readonly Ranged[]) {
  const references: Reference[] = sourceCode.scopeManager.scopes.flatMap(
    (scope: Scope) => scope.references,
  );

  const referenceOf = new Map<ESTree.Node, Reference>();

  for (const reference of references) referenceOf.set(reference.identifier, reference);

  function writeOf(reference: Reference): Write {
    const identifier = reference.identifier;
    const parent = identifier.parent;

    if (
      parent.type === "VariableDeclarator" &&
      parent.id === identifier &&
      parent.init !== null &&
      parent.parent.type === "VariableDeclaration" &&
      !(
        (parent.parent.parent.type === "ForOfStatement" ||
          parent.parent.parent.type === "ForInStatement") &&
        parent.parent.parent.left === parent.parent
      )
    ) {
      return { value: parent.init, keepsEarlier: false, statement: parent.parent };
    }

    if (parent.type === "AssignmentExpression" && parent.left === identifier) {
      return {
        value: parent.right,
        keepsEarlier: parent.operator !== "=",
        statement: parent.parent.type === "ExpressionStatement" ? parent.parent : null,
      };
    }

    return { value: null, keepsEarlier: false, statement: null };
  }

  /** The write always runs before the use: it is a whole statement in a block that holds the use, in the same function. */
  function dominates(statement: ESTree.Node | null, write: Reference, use: Reference): boolean {
    if (statement === null || write.from.variableScope !== use.from.variableScope) return false;

    const block = statement.parent;

    return (
      block !== null &&
      (block.type === "BlockStatement" ||
        block.type === "Program" ||
        block.type === "StaticBlock" ||
        block.type === "TSModuleBlock") &&
      within(use.identifier, block)
    );
  }

  /** The values the binding can hold at `use`. See the header for the reaching rule. */
  function reachingValues(variable: Variable, use: Reference): ESTree.Expression[] {
    const [definition] = variable.defs;

    if (definition === undefined || variable.defs.some((def) => def.type !== "Variable")) return [];

    const writes = variable.references.filter((reference) => reference.isWrite());
    const declaration = definition.parent;

    if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") {
      return writes.flatMap((write) => writeOf(write).value ?? []);
    }

    const above = writes
      .filter(
        (write) =>
          write.identifier.start < use.identifier.start &&
          (write.writeExpr === null || !within(use.identifier, write.writeExpr)),
      )
      .sort((a, b) => b.identifier.start - a.identifier.start);

    const values: ESTree.Expression[] = [];

    for (const write of above) {
      const { value, keepsEarlier, statement } = writeOf(write);

      if (value === null) break;
      values.push(value);

      if (!keepsEarlier && dominates(statement, write, use)) break;
    }

    return values;
  }

  /** A plain parameter (`s`, `s: T`, `s = d`) that nothing reassigns. */
  function parameterSlot(variable: Variable): ParameterSlot | null {
    const [definition] = variable.defs;

    if (variable.defs.length !== 1 || definition?.type !== "Parameter") return null;

    const fn = definition.node;

    if (!isFunctionNode(fn)) return null;

    const index = fn.params.findIndex(
      (param) =>
        param === definition.name ||
        (param.type === "AssignmentPattern" && param.left === definition.name),
    );

    const reassigned = variable.references.some(
      (reference) => reference.isWrite() && reference.identifier !== definition.name,
    );

    return index === -1 || reassigned ? null : { fn, index };
  }

  /** The name a function is called by in this file: its declaration, or a `const` that holds it. */
  function functionVariable(fn: FunctionNode): Variable | null {
    if (fn.type === "FunctionDeclaration" && fn.id !== null) {
      const name = fn.id.name;

      return sourceCode.getDeclaredVariables(fn).find((variable) => variable.name === name) ?? null;
    }

    const holder = fn.parent;

    if (
      holder.type === "VariableDeclarator" &&
      holder.init === fn &&
      holder.id.type === "Identifier" &&
      holder.parent.type === "VariableDeclaration" &&
      holder.parent.kind === "const"
    ) {
      return sourceCode.getDeclaredVariables(holder)[0] ?? null;
    }

    return null;
  }

  function collect(expression: Ranged, flow: Flow, seen: Set<Reference>): void {
    if (flow.json) return;

    if (jsonCalls.some((call) => within(call, expression))) {
      flow.json = true;

      return;
    }

    for (const reference of references) {
      if (!within(reference.identifier, expression) || seen.has(reference)) continue;

      if (!reference.isRead() || reference.resolved === null) continue;
      seen.add(reference);
      const variable = reference.resolved;

      if (parameterSlot(variable) !== null) {
        if (!flow.params.includes(variable)) flow.params.push(variable);
        continue;
      }

      for (const value of reachingValues(variable, reference)) {
        if (isFunctionNode(unwrap(value))) continue;
        collect(value, flow, seen);

        if (flow.json) return;
      }
    }
  }

  function isHasher(expression: ESTree.Expression, seen: Set<Reference>): boolean {
    const node = unwrap(expression);

    if (node.type === "CallExpression") {
      if (isCreateHash(node.callee)) return true;
      const member = staticMember(node.callee);

      return member !== null && member.name === "update" && isHasher(member.object, seen);
    }

    if (node.type !== "Identifier") return false;
    const reference = referenceOf.get(node);

    if (reference === undefined || reference.resolved === null || seen.has(reference)) return false;
    seen.add(reference);

    return reachingValues(reference.resolved, reference).some((value) => isHasher(value, seen));
  }

  const findings: { node: ESTree.Node; helper: string | null }[] = [];
  const reported = new Set<ESTree.Node>();

  function helperCalls(param: Variable, visited: Set<Variable>): void {
    const slot = parameterSlot(param);
    const fnVariable = slot === null ? null : functionVariable(slot.fn);

    if (slot === null || fnVariable === null || visited.has(fnVariable)) return;
    visited.add(fnVariable);

    for (const reference of fnVariable.references) {
      const call = reference.identifier.parent;

      if (call.type !== "CallExpression" || call.callee !== reference.identifier) continue;
      const argument = call.arguments[slot.index];

      if (argument === undefined) continue;

      if (call.arguments.slice(0, slot.index + 1).some((arg) => arg.type === "SpreadElement")) {
        continue;
      }

      const flow: Flow = { json: false, params: [] };
      collect(argument, flow, new Set());

      if (flow.json && !reported.has(argument)) {
        reported.add(argument);
        findings.push({ node: argument, helper: fnVariable.name });
      }

      if (!flow.json) for (const next of flow.params) helperCalls(next, visited);
    }
  }

  for (const sink of sinks) {
    if (sink.receiver !== null && !isHasher(sink.receiver, new Set())) continue;
    const flow: Flow = { json: false, params: [] };
    collect(sink.data, flow, new Set());

    if (flow.json) {
      findings.push({ node: sink.call, helper: null });
      continue;
    }

    for (const param of flow.params) helperCalls(param, new Set());
  }

  return findings;
}

/** Ban a content hash whose pre-image is `JSON.stringify` output. */
export const sha256OverJsonStringifyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a hash digest over JSON.stringify output, whose pre-image depends on object key order.",
    },
    messages: {
      jsonPreimage: `This digest hashes JSON.stringify output, so two equal values with different key order hash differently. ${FIX}`,
      jsonIntoHashHelper: `\`{{helper}}\` hashes this argument, and it holds JSON.stringify output, so two equal values with different key order hash differently. ${FIX}`,
    },
  },
  createOnce(context) {
    let sinks: Sink[] = [];
    let jsonCalls: ESTree.CallExpression[] = [];

    return {
      before() {
        sinks = [];
        jsonCalls = [];

        return inGateScope(context.filename, context.cwd);
      },
      CallExpression(node) {
        if (isJsonStringify(node)) {
          jsonCalls.push(node);

          return;
        }

        const sink = sinkOf(node);

        if (sink !== null) sinks.push(sink);
      },
      "Program:exit"() {
        if (sinks.length === 0 || jsonCalls.length === 0) return;

        for (const { node, helper } of analyzeFile(context.sourceCode, sinks, jsonCalls)) {
          if (helper === null) context.report({ node, messageId: "jsonPreimage" });
          else context.report({ node, messageId: "jsonIntoHashHelper", data: { helper } });
        }
      },
    };
  },
});
