import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { lexSource, parseImports } from "./ts-imports.mjs";
import { listWorkspaces } from "./workspaces.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_PATH = join(ROOT, "scripts/module-architecture-baseline.json");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const LEGACY_API_MODULES_ROOT = join(ROOT, "packages/api/src/modules");
const ASSISTANT_SOURCE_ROOT = join(ROOT, "packages/assistant/src");
const API_COMPOSITION_ROOT = join(ROOT, "packages/api/src/composition");
const RUNTIME_ADAPTER_MANIFEST = join(API_COMPOSITION_ROOT, "runtime-adapters.ts");
// The boot seams live in `@alfred/assistant`, not in the legacy api modules tree.
// They moved there before this constant did, and because `walkSourceFiles` returns
// `[]` for a directory that does not exist, the header rule below scanned zero files
// and reported success from the move until this repoint. `SCANNED_PATHS` is what stops
// the next move doing the same thing.
const TOOL_RUNTIME_ROOT = join(ASSISTANT_SOURCE_ROOT, "tool-runtime");
const BOOT_PORT_DEFINER = join(TOOL_RUNTIME_ROOT, "boot-port.ts");
// A boot-seam call is `bootPort` followed by a generic or an argument list. The
// character class covers both the `bootPort<Type>(` form and the bare `bootPort(`
// form, so a seam whose generic sits on the variable (const p: BootPort<T> =
// bootPort("x")) is still detected. No generic parse is needed: the check asks
// only whether a call exists and on which line, never where the generic ends.
const BOOT_PORT_CALL = /\bbootPort\s*[<(]/g;
// Reads the seam type name from a call-site generic (bootPort<Name>) or, for the
// bare form, from the variable annotation (: BootPort<Name>). The name only lets a
// header sit on the seam interface instead of the call line; a null name is fine.
const BOOT_PORT_GENERIC_NAME = /\bbootPort\s*<\s*([A-Za-z_$][\w$]*)/;
const BOOT_PORT_VARIABLE_TYPE = /:\s*BootPort\s*<\s*([A-Za-z_$][\w$]*)/;
// The evasion-proof backstop trigger. A seam cannot exist without importing the
// factory, so a file that imports bootPort but exposes no detectable call (an alias
// or other indirection) must still carry the four labels.
const BOOT_PORT_IMPORT = /\bimport\b[^;\n]*\bbootPort\b[^;\n]*\bfrom\b/;
const BOOT_SEAM_HEADER_LABELS = ["Surface:", "Owns/hides:", "Why the seam:", "Wiring:"];
const TARGET_ASSISTANT_MODULES = new Set([
  "action-policies",
  "artifacts",
  "automation",
  "briefings",
  "tool-runtime",
  "connections",
  "conversations",
  "corpus",
  "delivery",
  "triggers",
  "execution",
  "knowledge",
  "realtime",
  "settings",
  "skills",
  "tasks",
  "time",
  "triage",
]);
// The two roots that decide which module owns a file, as one parameter so a self-test
// can point the module derivation at a fixture tree. Both members are the existing
// constants, so this adds no path literal and no `SCANNED_PATHS` row: the rows for
// `ASSISTANT_SOURCE_ROOT` and `LEGACY_API_MODULES_ROOT` below already prove both
// resolve on every `pnpm check`.
const MODULE_ROOTS = {
  apiModules: LEGACY_API_MODULES_ROOT,
  assistantSource: ASSISTANT_SOURCE_ROOT,
};
const WEB_ROUTES_ROOT = join(ROOT, "apps/web/src/routes");
// The connections barrel and the two ingestion modules it must never reach, transitively.
// The barrel's own header records the convention in two lines: it does not re-export
// `./ingestion`, and `./oauth-state` imports the `./ingestion/workflow-recovery` LEAF rather
// than the ingestion barrel. Both lines exist because importing the ingestion barrel evaluates
// the BullMQ queue and the whole Gmail ingestion graph, and this barrel is reached by
// `@alfred/api/backend`'s `export *` and therefore by every operational script.
//
// This gate covers BOTH lines, not just the first. `export * from "./ingestion"` here is the
// direct violation; swapping `oauth-state`'s leaf import for the `./ingestion` barrel is the
// indirect one, and it fires too, because that barrel re-exports `queue` and `gmail-ingest`.
//
// It has to be a reachability walk rather than a `moduleEdges` row or an oxlint group.
// `moduleForPath` files `connections/ingestion/*` inside the `connections` module, so an
// intra-module reach produces NO edge and no arch rule can see the widening — measured:
// `export * from "./ingestion"` takes the barrel from 19 to 41 exports with `check:architecture`,
// `check:package-exports`, the retained-handle count and the exit code all unchanged. A one-hop
// oxlint group on `./ingestion` cannot express "transitively, except `workflow-recovery`", which
// is the actual convention.
//
// Absolute, and checked against the live walk rather than the baseline: a ratchet row would let a
// future PR regenerate the baseline and walk the invariant back.
const CONNECTIONS_BARREL = join(ASSISTANT_SOURCE_ROOT, "connections/index.ts");
const CONNECTIONS_BARREL_FORBIDDEN_REACH = [
  join(ASSISTANT_SOURCE_ROOT, "connections/ingestion/queue.ts"),
  join(ASSISTANT_SOURCE_ROOT, "connections/ingestion/gmail-ingest.ts"),
];
// Every hardcoded repository path a rule in this file reads. Each one is the SOLE
// input of its rule, so a path that stops resolving does not make its rule lenient —
// it makes it enforce nothing, silently for a directory (`walkSourceFiles` returns
// `[]`) and with an uncaught `node:fs` stack for a file. Absence is therefore a
// violation for every row, with no "legitimately empty" escape hatch: it always means
// one of two deliberate edits to this file — repoint the constant, or delete the rule
// that reads it — and `scannedPathLivenessViolations` names both.
//
// Listing a path here proves it resolves on every `pnpm check`. It does NOT force the
// next hardcoded path someone adds to be listed; that residue is real and is owned
// elsewhere, not claimed here.
const SCANNED_PATHS = [
  { constant: "ASSISTANT_SOURCE_ROOT", path: ASSISTANT_SOURCE_ROOT, kind: "directory" },
  { constant: "LEGACY_API_MODULES_ROOT", path: LEGACY_API_MODULES_ROOT, kind: "directory" },
  { constant: "WEB_ROUTES_ROOT", path: WEB_ROUTES_ROOT, kind: "directory" },
  { constant: "API_COMPOSITION_ROOT", path: API_COMPOSITION_ROOT, kind: "directory" },
  { constant: "TOOL_RUNTIME_ROOT", path: TOOL_RUNTIME_ROOT, kind: "directory" },
  { constant: "RUNTIME_ADAPTER_MANIFEST", path: RUNTIME_ADAPTER_MANIFEST, kind: "file" },
  { constant: "BOOT_PORT_DEFINER", path: BOOT_PORT_DEFINER, kind: "file" },
  { constant: "CONNECTIONS_BARREL", path: CONNECTIONS_BARREL, kind: "file" },
];
const GRAPH_FLAG = "--print-graph";
const BASELINE_FLAG = "--write-baseline";
// `--print-baseline` was the previous name, and its documented invocation redirected
// stdout into the baseline file. The shell truncates that file BEFORE this process
// starts, so the redirect destroyed the ratchet it was supposed to regenerate. The
// flag now writes the file itself; the old name is kept only to refuse loudly.
const REMOVED_BASELINE_FLAG = "--print-baseline";

// The durable-execution module. Its directory is now named `execution` (Phase 6-12).
// The graph node is the raw directory name — see `moduleForPath`.
const EXECUTION_MODULE = "execution";
// Product modules the durable-execution core must not import (ADR-0089). This is
// an ABSOLUTE forbidden set: it is checked against the live module graph, not
// the grandfathered baseline SCC, so a re-introduced product import fails even
// while `agent` still shares a baseline cycle with other product modules. The
// set only ever grows — each edge-removal PR that lands its module here:
//   `triage`    — item 06 (this rule's first entry)
//   `chat`      — item 03 (chat → conversations migration)
//   `workflows` — item 10 (homes the last brief recipe out of agent/)
const EXECUTION_FORBIDDEN_PRODUCT_MODULES = new Set(["triage", "workflows"]);

function normalizePath(path) {
  return path.split(sep).join("/");
}

function relativeToRoot(path) {
  return normalizePath(relative(ROOT, path));
}

function listDirectories(parent) {
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(parent, entry.name));
}

function walkSourceFiles(parent) {
  if (!existsSync(parent)) return [];
  const files = [];
  const pending = [parent];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (SOURCE_EXTENSIONS.includes(extname(entry.name))) {
        files.push(path);
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function exportedRuntimeLifecycleSymbols(source) {
  const tokens = lexSource(source);
  const symbols = [];
  const addSymbol = (token) => {
    if (
      token?.kind === "identifier" &&
      /^(?:register|unregister)[A-Z][A-Za-z0-9_$]*$/.test(token.value)
    ) {
      symbols.push(token.value);
    }
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "export") continue;
    let cursor = index + 1;
    if (tokens[cursor]?.value === "async") cursor += 1;
    if (tokens[cursor]?.value === "function") {
      addSymbol(tokens[cursor + 1]);
    } else if (["const", "let", "var"].includes(tokens[cursor]?.value)) {
      addSymbol(tokens[cursor + 1]);
    } else if (tokens[cursor]?.value === "{") {
      cursor += 1;
      while (cursor < tokens.length && tokens[cursor]?.value !== "}") {
        const local = tokens[cursor];
        if (local?.kind !== "identifier" || local.value === "type") {
          cursor += 1;
          continue;
        }
        if (tokens[cursor + 1]?.value === "as") {
          addSymbol(tokens[cursor + 2]);
          cursor += 3;
        } else {
          addSymbol(local);
          cursor += 1;
        }
      }
    }
  }
  return uniqueSorted(symbols);
}

function namedImports(source) {
  const tokens = lexSource(source);
  const imports = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "import" || tokens[index + 1]?.value !== "{") continue;
    let cursor = index + 2;
    const names = [];
    while (cursor < tokens.length && tokens[cursor]?.value !== "}") {
      const token = tokens[cursor];
      if (token?.kind === "identifier" && token.value !== "type" && token.value !== "as") {
        names.push(token.value);
      }
      cursor += 1;
    }
    while (cursor < tokens.length && tokens[cursor]?.value !== "from") cursor += 1;
    const specifier = tokens[cursor + 1];
    if (specifier?.kind !== "string") continue;
    for (const name of names) imports.push({ name, specifier: specifier.value });
  }
  return imports;
}

function runtimeAdapterManifestRows(source) {
  const tokens = lexSource(source);
  const manifestName = tokens.findIndex((token) => token.value === "RUNTIME_ADAPTERS");
  const start = tokens.findIndex((token, index) => index > manifestName && token.value === "[");
  if (manifestName < 0 || start < 0) return [];

  const rows = [];
  let bracketDepth = 1;
  let braceDepth = 0;
  let register;
  let unregister;
  for (let index = start + 1; index < tokens.length && bracketDepth > 0; index += 1) {
    const token = tokens[index];
    if (token.value === "[") bracketDepth += 1;
    else if (token.value === "]") bracketDepth -= 1;
    else if (token.value === "{") {
      braceDepth += 1;
      if (braceDepth === 1) {
        register = undefined;
        unregister = undefined;
      }
    } else if (token.value === "}") {
      if (braceDepth === 1 && register && unregister) rows.push({ register, unregister });
      braceDepth -= 1;
    } else if (
      braceDepth === 1 &&
      (token.value === "register" || token.value === "unregister") &&
      tokens[index + 1]?.value === ":" &&
      tokens[index + 2]?.kind === "identifier"
    ) {
      if (token.value === "register") register = tokens[index + 2].value;
      else unregister = tokens[index + 2].value;
    }
  }
  return rows;
}

function runtimeAdapterViolations(compositionSources, manifestSource) {
  const violations = [];
  const expectedPairs = [];
  for (const { file, source } of compositionSources) {
    const symbols = exportedRuntimeLifecycleSymbols(source);
    const registers = symbols.filter((symbol) => symbol.startsWith("register"));
    const unregisters = symbols.filter((symbol) => symbol.startsWith("unregister"));
    const suffixes = uniqueSorted([
      ...registers.map((symbol) => symbol.slice("register".length)),
      ...unregisters.map((symbol) => symbol.slice("unregister".length)),
    ]);
    for (const suffix of suffixes) {
      const register = `register${suffix}`;
      const unregister = `unregister${suffix}`;
      if (!registers.includes(register) || !unregisters.includes(unregister)) {
        violations.push(
          `unpaired runtime adapter lifecycle in ${relativeToRoot(file)}: expected ${register} and ${unregister}`,
        );
        continue;
      }
      const relativeModule = normalizePath(relative(API_COMPOSITION_ROOT, file)).replace(
        /\.[^.]+$/,
        "",
      );
      expectedPairs.push({
        register,
        specifier: relativeModule.startsWith(".") ? relativeModule : `./${relativeModule}`,
        unregister,
      });
    }
  }

  const imports = namedImports(manifestSource);
  const rows = runtimeAdapterManifestRows(manifestSource);
  for (const expected of expectedPairs) {
    for (const symbol of [expected.register, expected.unregister]) {
      if (
        !imports.some(
          (imported) => imported.name === symbol && imported.specifier === expected.specifier,
        )
      ) {
        violations.push(
          `runtime adapter manifest must import ${symbol} from ${expected.specifier}`,
        );
      }
    }
    const matches = rows.filter(
      (row) => row.register === expected.register && row.unregister === expected.unregister,
    );
    if (matches.length !== 1) {
      violations.push(
        `runtime adapter manifest must list ${expected.register}/${expected.unregister} exactly once (found ${matches.length})`,
      );
    }
  }

  const expectedRowKeys = new Set(
    expectedPairs.map(({ register, unregister }) => `${register}/${unregister}`),
  );
  for (const row of rows) {
    const key = `${row.register}/${row.unregister}`;
    if (!expectedRowKeys.has(key)) {
      violations.push(`runtime adapter manifest lists unknown lifecycle pair ${key}`);
    }
  }
  return violations.sort((a, b) => a.localeCompare(b));
}

// Finds every bootPort call in a source and the line it sits on. A call is the
// identifier followed by `<` or `(`, so both the `bootPort<Type>(` form and the bare
// `bootPort(` form (generic on the variable) are found. It reads the seam type name
// when one is available, only so a header may sit on the seam interface instead of
// the call line; a null name still anchors to the call line.
function findBootPortCalls(source) {
  const calls = [];
  const lines = source.split("\n");
  BOOT_PORT_CALL.lastIndex = 0;
  let match;
  while ((match = BOOT_PORT_CALL.exec(source)) !== null) {
    const lineIndex = source.slice(0, match.index).split("\n").length - 1;
    const line = lines[lineIndex];
    const fromCall = line.match(BOOT_PORT_GENERIC_NAME);
    const fromVariable = line.match(BOOT_PORT_VARIABLE_TYPE);
    const seamTypeName = fromCall ? fromCall[1] : fromVariable ? fromVariable[1] : null;
    calls.push({ seamTypeName, lineIndex });
  }
  return calls;
}

// Returns the JSDoc block that sits immediately above an anchor line (blank lines
// skipped), or null when no block touches the anchor. A header only counts for a
// seam when it is adjacent to that seam's anchor, so a label repeated far away in
// prose cannot stand in for a real header.
function adjacentJsDocBlock(lines, anchorLineIndex) {
  let k = anchorLineIndex - 1;
  while (k >= 0 && lines[k].trim() === "") k--;
  if (k < 0 || !lines[k].includes("*/")) return null;
  const blockLines = [];
  for (; k >= 0; k--) {
    blockLines.unshift(lines[k]);
    if (lines[k].includes("/**")) return blockLines.join("\n");
  }
  return null;
}

// A boot-seam header must be bound to its seam by position, not counted file-wide.
// A file can host many seams (index.ts holds four); each needs its own four-field
// header. The header sits on the seam's interface (or, when the interface lives in
// another module, on the bootPort call), so each seam's anchor is its interface
// declaration or its call line. A seam whose adjacent header omits any of the four
// labels fails the check.
function bootSeamHeaderViolations(sources) {
  const violations = [];
  for (const { file, source } of sources) {
    const calls = findBootPortCalls(source);
    if (calls.length === 0) {
      // Import-anchor backstop. A seam cannot exist without importing the factory, so
      // a file that imports bootPort yet exposes no detectable call (an alias or other
      // indirection) must still carry the four labels. This closes the forms a
      // call-site scan cannot enumerate, at no parsing cost.
      if (BOOT_PORT_IMPORT.test(source)) {
        const missing = BOOT_SEAM_HEADER_LABELS.filter((label) => !source.includes(label));
        for (const label of missing) {
          violations.push(`boot-seam header missing "${label}" in ${relativeToRoot(file)}`);
        }
      }
      continue;
    }
    const lines = source.split("\n");
    for (const call of calls) {
      const anchorLines = [call.lineIndex];
      if (call.seamTypeName) {
        // A validated identifier holds no regex metacharacters, so it is safe here.
        const interfacePattern = new RegExp(
          `^\\s*(export\\s+)?interface\\s+${call.seamTypeName}\\b`,
        );
        for (let i = 0; i < lines.length; i++) {
          if (interfacePattern.test(lines[i])) anchorLines.push(i);
        }
      }
      // One block must carry all four labels. The union of two partial blocks does
      // not count, so pick the single adjacent block with the most labels and report
      // what it still misses.
      let bestLabels = [];
      for (const anchorLine of anchorLines) {
        const block = adjacentJsDocBlock(lines, anchorLine);
        if (block === null) continue;
        const present = BOOT_SEAM_HEADER_LABELS.filter((label) => block.includes(label));
        if (present.length > bestLabels.length) bestLabels = present;
      }
      const seam = call.seamTypeName ?? "anonymous seam";
      for (const label of BOOT_SEAM_HEADER_LABELS) {
        if (!bestLabels.includes(label)) {
          violations.push(
            `boot-seam header missing "${label}" for ${seam} in ${relativeToRoot(file)}`,
          );
        }
      }
    }
  }
  return violations.sort((a, b) => a.localeCompare(b));
}

function resolveSourceImport(importer, specifier) {
  let candidate;
  if (specifier.startsWith(".")) {
    candidate = resolve(dirname(importer), specifier);
  } else if (specifier.startsWith("~/")) {
    const appSourceMatch = importer.match(/^(.*\/apps\/[^/]+\/src)\//);
    if (!appSourceMatch?.[1]) return null;
    candidate = join(appSourceMatch[1], specifier.slice(2));
  } else {
    return null;
  }
  const extension = extname(candidate);
  const bases =
    extension === ".js" || extension === ".jsx"
      ? [candidate, candidate.slice(0, -extension.length)]
      : [candidate];
  const candidates = [...bases];
  for (const base of bases) {
    for (const sourceExtension of SOURCE_EXTENSIONS) candidates.push(`${base}${sourceExtension}`);
    for (const sourceExtension of SOURCE_EXTENSIONS) {
      candidates.push(join(base, `index${sourceExtension}`));
    }
  }
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? candidate;
}

/**
 * The workspaces this checker walks, absolute-path throughout as the rest of the
 * file is, plus whatever the enumeration itself refused.
 *
 * A workspace with no `name` is dropped because every use of an entry here is
 * keyed on identity: an edge is `from` one name `to` another, and a specifier is
 * matched against a name. The failures travel with the entries so a graph derived
 * from nothing cannot be reported as a clean graph.
 */
function workspaceEntries() {
  const { workspaces, failures } = listWorkspaces(ROOT);
  const entries = workspaces
    .filter((workspace) => workspace.name !== null)
    .map((workspace) => ({
      directory: join(ROOT, workspace.dir),
      name: workspace.name,
      source: join(ROOT, workspace.source),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) {
    failures.push(
      "no workspace declares a `name`, so this check has no package to walk and no edge it could report.",
    );
  }
  return { entries, failures };
}

function entryForFile(entries, file) {
  return entries.find(
    (entry) => file === entry.directory || file.startsWith(`${entry.directory}${sep}`),
  );
}

function packageFromSpecifier(entries, specifier) {
  return entries.find(
    (entry) => specifier === entry.name || specifier.startsWith(`${entry.name}/`),
  );
}

// `roots` is a parameter for the same reason `collectImportFacts` takes one: module
// identity is only decided from inside the import walk, so a drive that plants a
// fixture module tree outside the repository has to be able to point this at it.
function moduleForPath(path, roots = MODULE_ROOTS) {
  if (path.startsWith(`${roots.apiModules}${sep}`)) {
    const [name] = relative(roots.apiModules, path).split(sep);
    return name ? { index: join(roots.apiModules, name, "index.ts"), name } : null;
  }
  if (path.startsWith(`${roots.assistantSource}${sep}`)) {
    const [name] = relative(roots.assistantSource, path).split(sep);
    return name && TARGET_ASSISTANT_MODULES.has(name)
      ? { index: join(roots.assistantSource, name, "index.ts"), name }
      : null;
  }
  return null;
}

// `routesRoot` is a parameter for the same reason `collectImportFacts` takes one: the
// two-arm feature derivation is only reachable from the import walk, so a drive that
// plants a fixture route tree outside the repository has to be able to point both at it.
function webFeatureForPath(path, routesRoot = WEB_ROUTES_ROOT) {
  if (!path.startsWith(`${routesRoot}${sep}`)) return null;
  const [first] = relative(routesRoot, path).split(sep);
  return first?.startsWith("-") ? first.slice(1) : null;
}

function edgeKey(from, to) {
  return `${from} -> ${to}`;
}

function importKey(file, specifier) {
  return `${relativeToRoot(file)}:${specifier}`;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function stronglyConnectedComponents(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node, []]));
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from)?.push(edge.to);
  }
  for (const targets of adjacency.values()) targets.sort((a, b) => a.localeCompare(b));

  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function connect(node) {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency.get(node) ?? []) {
      if (!indexes.has(target)) {
        connect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(target)));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort((a, b) => a.localeCompare(b)));
  }

  for (const node of [...adjacency.keys()].sort((a, b) => a.localeCompare(b))) {
    if (!indexes.has(node)) connect(node);
  }
  return components.sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
}

function cyclicEdgeKeys(edges, components) {
  const componentByNode = new Map();
  for (const component of components) {
    for (const node of component) componentByNode.set(node, component);
  }
  return uniqueSorted(
    edges
      .filter((edge) => {
        const component = componentByNode.get(edge.from);
        return (
          component &&
          component.includes(edge.to) &&
          (component.length > 1 || edge.from === edge.to)
        );
      })
      .map((edge) => edgeKey(edge.from, edge.to)),
  );
}

/**
 * Split `"A -> B"` graph keys back into edge records. The live graph and the
 * committed baseline both store edges as keys, so this is the one spelling of the
 * split.
 */
function edgesFromKeys(keys) {
  return keys.map((key) => {
    const [from, to] = key.split(" -> ");
    return { from, to };
  });
}

/**
 * The ratchet set, declared once.
 *
 * A ratchet is a list {@link baselineDocument} re-derives from the current tree and
 * {@link checkArchitecture} consults as a permission record. Each row names the dotted
 * `path` that reads the list out of BOTH the committed baseline and the emitted document
 * — which is also the name a fault sentence carries — and the `channel` the regeneration
 * delta reports it under. The persisted-shape validator, the delta and the self-test's
 * drive list are all derived from this table, so a ratchet cannot exist in one of them
 * and be missing from another.
 *
 * `memberKind` is why this is not a bare list of paths. The two graph rows hold
 * `"A -> B"` keys that {@link edgesFromKeys} SPLITS, so a member that does not split into
 * two non-empty sides would mint a permission for a prefix of itself. Both
 * `legacyExceptions` rows hold {@link importKey} keys — `path:specifier`, a COLON key —
 * which are never split and are compared as opaque literals, so the same check would
 * reject every real entry.
 *
 * `declaredCyclesPath` is why the two graph rows carry a second path. A recorded graph
 * must DECLARE the cycles it records, and {@link baselineSelfPermissionFaults} holds the
 * two lists to each other. Only the graph rows have one: the `legacyExceptions` lists are
 * flat allowlists with no derived companion.
 *
 * The two sites this table is deliberately NOT projected into are
 * {@link checkArchitecture}'s four comparisons and {@link baselineDocument}: the two
 * families have different algebras (an SCC pass over split keys against literal set
 * membership) and different message shapes, so a shared `compare` callback would be the
 * same restatement in another spelling inside the function ADR-0089's cycle fence rests
 * on. Their agreement with this table is held by the self-test instead — a per-row drive
 * plants one violating member and requires the comparison to report it, and a document
 * walk requires every array the document emits to be a row here or a `declaredCyclesPath`
 * of one.
 */
const BASELINE_RATCHETS = [
  {
    channel: "packageEdges",
    path: "packageGraph.edges",
    memberKind: "edgeKey",
    declaredCyclesPath: "packageGraph.sccs",
  },
  {
    channel: "moduleEdges",
    path: "assistantModuleGraph.edges",
    memberKind: "edgeKey",
    declaredCyclesPath: "assistantModuleGraph.sccs",
  },
  {
    channel: "privateModuleImports",
    path: "legacyExceptions.privateModuleImports.imports",
    memberKind: "opaque",
  },
  {
    channel: "webFeatureImports",
    path: "legacyExceptions.webFeatureImports.imports",
    memberKind: "opaque",
  },
];

/**
 * The rows of {@link BASELINE_RATCHETS} that record a graph, and so must declare the
 * cycles they record. Derived from the table rather than listed a second time, so a
 * renamed or removed graph cannot leave a cross-check pointing at the old spelling.
 */
const RECORDED_GRAPHS = BASELINE_RATCHETS.filter(
  (ratchet) => ratchet.declaredCyclesPath !== undefined,
);

/**
 * Read a dotted path off unknown persisted data, returning `undefined` on a missing hop
 * rather than throwing.
 *
 * `getPath` from `@alfred/contracts` is the repo's helper for this shape, and it cannot
 * be used here: `scripts/*.mjs` run under bare `node` and may import node builtins only,
 * while `@alfred/contracts` resolves through its `exports` map to TypeScript SOURCE this
 * process cannot load. Same reason {@link edgesFromKeys} and {@link uniqueSorted} are
 * local.
 */
function ratchetList(root, path) {
  let value = root;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

/**
 * The CYCLIC SUBSET of a recorded edge list.
 *
 * `scripts/module-architecture-baseline.json` records the whole graph, but
 * {@link checkArchitecture} consults it as a cycle ALLOWLIST: an entry there means
 * "this cyclic edge is permitted". Comparing a live cycle against the raw recorded
 * list conflates the two — an edge recorded because it was ordinary acyclic debt
 * would double as a permission slip on the day it joins a cycle, and a new cycle
 * whose forward direction happens to be recorded would be reported in one direction
 * only. Putting the recorded list through the SAME SCC pass the live graph goes
 * through settles it: a recorded ACYCLIC edge grants nothing, so the recorded graph
 * is a record, not a permission.
 */
function cyclicEdgeKeysOf(keys) {
  const edges = edgesFromKeys(keys);
  return cyclicEdgeKeys(
    edges,
    stronglyConnectedComponents(uniqueSorted(edges.flatMap((edge) => [edge.from, edge.to])), edges),
  );
}

function listDelta(before, after) {
  const beforeEntries = new Set(before);
  const afterEntries = new Set(after);
  return {
    added: uniqueSorted(after.filter((entry) => !beforeEntries.has(entry))),
    removed: uniqueSorted(before.filter((entry) => !afterEntries.has(entry))),
  };
}

function graphFromEdges(nodes, rawEdges) {
  const keys = uniqueSorted(rawEdges.map((edge) => edgeKey(edge.from, edge.to)));
  const edges = keys.map((key) => {
    const [from, to] = key.split(" -> ");
    return { from, to };
  });
  const allNodes = uniqueSorted([...nodes, ...edges.flatMap((edge) => [edge.from, edge.to])]);
  const components = stronglyConnectedComponents(allNodes, edges);
  return {
    edges: keys,
    sccs: components.filter((component) => component.length > 1),
  };
}

/**
 * The runtime-adapter rule's two tree reads, in the one place this file reads the tree
 * (item 38). Both paths are parameters for the same reason `loadBaseline(path =
 * BASELINE_PATH)`'s is: a self-test can then drive the absent case without moving a
 * real file aside.
 *
 * The manifest read is guarded HERE, at the read, and consults no {@link SCANNED_PATHS}
 * row — a guard paired with the wrong row is invisible on a clean tree, while a guard
 * that observes the absence it is guarding against cannot be mispaired. An absent
 * manifest is reported by its own row; this returns `null` so the rule that needs it
 * simply does not run.
 */
function collectRuntimeAdapterScan(
  root = API_COMPOSITION_ROOT,
  manifest = RUNTIME_ADAPTER_MANIFEST,
) {
  const compositionSources = walkSourceFiles(root)
    .filter((file) => file !== manifest)
    .map((file) => ({ file, source: readFileSync(file, "utf8") }));
  const manifestPresent = existsSync(manifest) && statSync(manifest).isFile();
  return {
    compositionSources,
    manifestSource: manifestPresent ? readFileSync(manifest, "utf8") : null,
  };
}

/**
 * The boot-seam rule's tree read (item 38). The filter is declared once here and read
 * by both `checkArchitecture`'s rule and the discovery drive, which held a duplicate of
 * these three lines — two copies of a filter are how the two drift apart.
 * `walkSourceFiles` returns `[]` for an absent root, so absence needs no guard beyond
 * the row that reports it.
 */
function collectBootSeamSources(root = TOOL_RUNTIME_ROOT, definer = BOOT_PORT_DEFINER) {
  return walkSourceFiles(root)
    .filter((file) => !/\.test\.tsx?$/.test(file) && file !== definer)
    .map((file) => ({ file, source: readFileSync(file, "utf8") }));
}

/**
 * The barrel-reach rule's tree read (item 38): a breadth-first walk of the relative import
 * graph rooted at {@link CONNECTIONS_BARREL}, plus the presence of each forbidden target.
 *
 * Breadth-first, so the recorded chain for a reached file is the SHORTEST one. "the barrel
 * reaches queue.ts" without the hops is unactionable; `index.ts -> ingestion/index.ts ->
 * queue.ts` names the import to delete.
 *
 * Uses `parseImports`, never a regex. This barrel's own header contains the literal string
 * `export * from "./ingestion"` as prose, so a hand-rolled pattern reports a false reach into
 * `queue.ts` on a clean tree; the lexer consumes comments and strings and does not.
 *
 * Only relative specifiers become hops — a bare package specifier leaves this package, which is
 * the module-graph rules' subject, not this one. `resolveSourceImport` is the SOLE arbiter of
 * that: it returns null for every specifier that starts with neither `.` nor `~/`, and a `~/`
 * specifier resolves only from inside an `apps/<app>/src` tree, which no barrel this rule walks
 * is in. A second `startsWith(".")` guard here was measured to be unobservable — removing it
 * changed no drive — and this file does not keep branches no mutant can reach. What does hold
 * the line is `(f-c)`'s exact reached-file count, over a fixture whose barrel exports from a
 * bare package specifier. Separately, `resolveSourceImport` returns the unresolved CANDIDATE
 * rather than null when nothing exists at a relative path, so every hop is also filtered on
 * being a real file.
 *
 * Both arguments are parameters so the self-test can walk a fixture tree with the production
 * walk instead of a copy of it, the same reason `collectBootSeamSources` takes its root.
 *
 * @param {string} barrel
 * @param {string[]} forbidden
 * @returns {{ reached: { chain: string, file: string }[],
 *             forbidden: { path: string, present: boolean }[] }}
 */
function collectConnectionsBarrelReach(
  barrel = CONNECTIONS_BARREL,
  forbidden = CONNECTIONS_BARREL_FORBIDDEN_REACH,
) {
  const base = dirname(barrel);
  const label = (file) => normalizePath(relative(base, file));
  const isFile = (path) => existsSync(path) && statSync(path).isFile();
  const reached = [];
  if (isFile(barrel)) {
    const seen = new Set([barrel]);
    reached.push({ chain: label(barrel), file: barrel });
    // `reached` IS the queue: an array iterator re-reads `length` on every step, so a file
    // appended here is visited later in the same loop, in insertion order. That is the
    // breadth-first order, without a second array and without a `shift()` whose result the
    // checker would have to prove non-empty.
    for (const current of reached) {
      for (const imported of parseImports(readFileSync(current.file, "utf8"))) {
        const target = resolveSourceImport(current.file, imported.specifier);
        if (target === null || seen.has(target) || !isFile(target)) continue;
        seen.add(target);
        reached.push({ chain: `${current.chain} -> ${label(target)}`, file: target });
      }
    }
  }
  return {
    reached,
    forbidden: forbidden.map((path) => ({ path, present: isFile(path) })),
  };
}

/**
 * The import walk, roots as parameters. Three fence predicates below — ADR-0089's
 * assistant-to-transport rule, its private cross-module import rule, and the
 * production-to-preview rule — decide membership here. The live tree holds zero members
 * of the first and third, so a narrowed predicate collects the same empty list as a
 * correct one, and a narrowed private-reach predicate collects a shorter list that every
 * baselined key still covers. Taking `entries`, `routesRoot` and `moduleRoots` as
 * arguments is what lets a self-test drive run THIS function over a planted fixture
 * instead of a copy of it; a copy of the walk inside the drive is how the two drift
 * (the same reason `collectBootSeamSources` takes its root).
 *
 * @param {{ directory: string, name: string, source: string }[]} entries
 * @param {string} routesRoot
 * @param {{ apiModules: string, assistantSource: string }} moduleRoots
 * @returns {{ packageEdges: { from: string, to: string }[],
 *             moduleEdges: { from: string, to: string }[],
 *             exceptions: {
 *               privateModuleImports: { from: string, key: string, line: number, to: string }[],
 *               webFeatureImports: { from: string, key: string, line: number, to: string }[] },
 *             forbiddenBackendImports: { key: string, line: number }[],
 *             productionPreviewImports: { key: string, line: number }[] }}
 */
function collectImportFacts(entries, routesRoot = WEB_ROUTES_ROOT, moduleRoots = MODULE_ROOTS) {
  const packageEdges = [];
  const moduleEdges = [];
  const privateModuleImports = [];
  const webFeatureImports = [];
  const forbiddenBackendImports = [];
  const productionPreviewImports = [];

  for (const entry of entries) {
    for (const file of walkSourceFiles(entry.source)) {
      const source = readFileSync(file, "utf8");
      for (const imported of parseImports(source)) {
        const targetFile = resolveSourceImport(file, imported.specifier);
        const targetEntry = targetFile
          ? entryForFile(entries, targetFile)
          : packageFromSpecifier(entries, imported.specifier);
        if (targetEntry && targetEntry.name !== entry.name) {
          packageEdges.push({ from: entry.name, to: targetEntry.name });
        }

        const fromModule = moduleForPath(file, moduleRoots);
        let toModule = targetFile ? moduleForPath(targetFile, moduleRoots) : null;
        if (!toModule && imported.specifier.startsWith("@alfred/api/modules/")) {
          const name = imported.specifier.split("/")[3];
          if (name) {
            toModule = {
              index: join(moduleRoots.apiModules, name, "index.ts"),
              name,
            };
          }
        } else if (!toModule && imported.specifier.startsWith("@alfred/assistant/")) {
          const name = imported.specifier.split("/")[2];
          if (name && TARGET_ASSISTANT_MODULES.has(name)) {
            toModule = {
              index: join(moduleRoots.assistantSource, name, "index.ts"),
              name,
            };
          }
        }
        // A module EDGE needs two module endpoints: it names the modules at both
        // ends, so an importer outside every module contributes no edge.
        if (fromModule && toModule && fromModule.name !== toModule.name) {
          moduleEdges.push({ from: fromModule.name, to: toModule.name });
        }
        // A private REACH needs only one module endpoint — the target's. Any file
        // that resolves an import to another module's non-index file has reached
        // past that module's public interface, whether or not the importer itself
        // lives in a module directory: the wiring files in `packages/api/src`,
        // `packages/http` and `apps/server` are exactly the ones that can do it.
        //
        // A null `targetFile` is what holds bare package specifiers out. The custom
        // resolver returns null for anything that does not start with `.` or `~/`,
        // so a `@alfred/assistant/<m>` or `@alfred/api/modules/<m>` specifier
        // synthesizes a `toModule` with no resolved file: it addresses the module by
        // its public subpath and cannot name an implementation file. Only a resolved
        // non-index target — a relative deep import — is a private reach.
        if (
          toModule &&
          targetFile !== null &&
          targetFile !== toModule.index &&
          fromModule?.name !== toModule.name
        ) {
          privateModuleImports.push({
            from: fromModule?.name ?? entry.name,
            key: importKey(file, imported.specifier),
            line: imported.line,
            to: toModule.name,
          });
        }

        if (
          entry.name === "@alfred/assistant" &&
          (imported.specifier === "@alfred/http" ||
            imported.specifier.startsWith("@alfred/http/") ||
            imported.specifier === "@alfred/api" ||
            imported.specifier.startsWith("@alfred/api/") ||
            targetEntry?.name === "server")
        ) {
          forbiddenBackendImports.push({
            key: importKey(file, imported.specifier),
            line: imported.line,
          });
        }

        if (entry.name === "web" && targetFile) {
          const fromFeature = webFeatureForPath(file, routesRoot);
          const toFeature = webFeatureForPath(targetFile, routesRoot);
          if (fromFeature && toFeature && fromFeature !== toFeature) {
            webFeatureImports.push({
              from: fromFeature,
              key: importKey(file, imported.specifier),
              line: imported.line,
              to: toFeature,
            });
          }
          const targetIsPreview = toFeature === "debug" || toFeature?.startsWith("preview-");
          const sourceIsPreview =
            fromFeature === "debug" ||
            fromFeature?.startsWith("preview-") ||
            /^(debug|preview)\./.test(relative(routesRoot, file));
          if (targetIsPreview && !sourceIsPreview) {
            productionPreviewImports.push({
              key: importKey(file, imported.specifier),
              line: imported.line,
            });
          }
        }
      }
    }
  }

  return {
    exceptions: {
      privateModuleImports: privateModuleImports.sort((a, b) => a.key.localeCompare(b.key)),
      webFeatureImports: webFeatureImports.sort((a, b) => a.key.localeCompare(b.key)),
    },
    forbiddenBackendImports,
    moduleEdges,
    packageEdges,
    productionPreviewImports,
  };
}

function collectArchitecture() {
  const { entries, failures: workspaceFailures } = workspaceEntries();
  const {
    exceptions,
    forbiddenBackendImports,
    moduleEdges,
    packageEdges,
    productionPreviewImports,
  } = collectImportFacts(entries);

  const moduleNodes = [
    ...listDirectories(LEGACY_API_MODULES_ROOT).map((path) => path.split(sep).at(-1)),
    ...listDirectories(ASSISTANT_SOURCE_ROOT)
      .map((path) => path.split(sep).at(-1))
      .filter((name) => name && TARGET_ASSISTANT_MODULES.has(name)),
  ];
  return {
    // Every tree read a rule needs is collected here, so `checkArchitecture` decides
    // over its arguments alone (item 38). Before this the boot-seam and runtime-adapter
    // rules read the tree from inside the check, which made every self-test drive run
    // the real scans, forced each drive to assert positively, and made the emit/refuse
    // drive a tautology.
    bootSeamSources: collectBootSeamSources(),
    connectionsBarrelReach: collectConnectionsBarrelReach(),
    exceptions,
    forbiddenBackendImports,
    moduleGraph: graphFromEdges(moduleNodes, moduleEdges),
    // The directory-derived live module nodes, surfaced so the execution-gate
    // liveness check (item 11) reads the true node set. It cannot use the
    // edge-derived nodes from `moduleGraph`, which omit any zero-edge module —
    // and a post-rename `agent` is exactly that zero-edge case the gate defends.
    moduleNodes: uniqueSorted(moduleNodes),
    packageGraph: graphFromEdges(
      entries.map((entry) => entry.name),
      packageEdges,
    ),
    productionPreviewImports,
    runtimeAdapterScan: collectRuntimeAdapterScan(),
    scannedPaths: scannedPathPresence(),
    workspaceFailures,
  };
}

function baselineDocument(architecture) {
  return {
    version: 1,
    target: "docs/plans/agent-friendly-module-structure.md",
    packageGraph: architecture.packageGraph,
    assistantModuleGraph: architecture.moduleGraph,
    legacyExceptions: {
      privateModuleImports: {
        owner: "assistant-migration",
        removalPhase: "Phases 1-6",
        reason:
          "Existing API modules import another module's implementation. Each migration slice must remove entries and cannot add replacements.",
        imports: uniqueSorted(
          architecture.exceptions.privateModuleImports.map((entry) => entry.key),
        ),
      },
      webFeatureImports: {
        owner: "web-architecture",
        removalPhase: "Phase 7",
        reason:
          "Existing route-private imports include preview/styleguide adapters and product feature coupling. Phase 7 removes product coupling; no caller may add another cross-feature door.",
        imports: uniqueSorted(architecture.exceptions.webFeatureImports.map((entry) => entry.key)),
      },
    },
  };
}

/**
 * Read the committed baseline as UNKNOWN persisted data and report every way it can
 * fail to be one, rather than throwing out of the middle of a check. A truncated or
 * hand-mangled file must name itself: `JSON.parse("")` raises a bare `SyntaxError`
 * that reads like a crash in this script.
 *
 * `path` is a parameter so the self-test can drive the missing-file and unparseable
 * branches without writing to disk — every caller in this script passes nothing.
 *
 * A rejection carries only `error` and an acceptance only `baseline`, for the same
 * reason and by the same mechanism as {@link baselineEmission}: the literal `ok` makes
 * reading the wrong one a compile error rather than an `undefined` some later caller
 * has to notice at run time.
 *
 * The accepted `baseline` stays `unknown`. Only the ratchet lists are validated here,
 * so the rest of the document is whatever the file held, and it is typed as it is read
 * rather than as it is hoped.
 *
 * @typedef {{ok: false, error: string}} BaselineRejection
 * @typedef {{ok: true, baseline: unknown}} BaselineAcceptance
 *
 * @param {string} [path]
 * @returns {BaselineRejection | BaselineAcceptance}
 */
function loadBaseline(path = BASELINE_PATH) {
  if (!existsSync(path)) {
    return { ok: false, error: `missing ${relativeToRoot(path)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      error: `${relativeToRoot(path)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const faults = baselineRatchetFaults(parsed);
  if (faults.length > 0) {
    return {
      ok: false,
      error: `${relativeToRoot(path)} has unusable ratchet lists: ${faults.join(", ")}`,
    };
  }
  const selfPermissions = baselineSelfPermissionFaults(parsed);
  if (selfPermissions.length > 0) {
    return {
      ok: false,
      error: `${relativeToRoot(path)} permits a cycle it does not declare: ${selfPermissions.join(", ")}. A recorded graph must declare its own cycles. A file in this state is what merging two independently regenerated baselines produces, and it grants a cycle neither side granted. Restore the file, then regenerate it from this tree with ${BASELINE_FLAG}, which refuses while the tree still has that cycle.`,
    };
  }
  return { ok: true, baseline: parsed };
}

/**
 * Every way a parsed baseline's ratchet lists can fail to be lists of keys of their own
 * spelling, as sentences naming the offending list. One row of {@link BASELINE_RATCHETS}
 * is one list checked here.
 *
 * The list TYPE is not enough: {@link checkArchitecture} routes every recorded key
 * through {@link edgesFromKeys}, which splits it, and both `legacyExceptions` lists are
 * compared as string keys. So a non-string member of a hand-edited file — the edit path
 * a refusal explicitly invites — is an uncaught `TypeError` in the middle of the check
 * unless the member type is checked HERE, in the boundary that already owns the shape.
 *
 * The member SHAPE is checked for `edgeKey` rows only, and it is the one thing in this
 * script that can newly refuse a file accepted before it: `edgesFromKeys` splits on the
 * FIRST `" -> "`, so a hand-edited `"a -> b -> c"` silently mints a permission for
 * `a -> b`, an edge the file does not name. `opaque` rows must not get this check —
 * their members are {@link importKey} colon keys and every real one would fail it.
 *
 * Each recorded graph's `declaredCyclesPath` list is checked here too, for the same
 * reason one hop down: {@link baselineSelfPermissionFaults} compares it member by member
 * against a derived component list, so a hand-edited `[["a", 42]]` would be an uncaught
 * `TypeError` in the middle of that comparison. It is a list of lists of node names, not
 * a list of keys, so it gets its own loop rather than a `memberKind`. A baseline with no
 * `sccs` is refused by name — fails closed, because a recorded graph that declares
 * nothing would otherwise pass the cross-check by permitting everything.
 *
 * @param {unknown} parsed The committed file exactly as it was read. This function is
 *   the boundary that owns the shape, so it takes the persisted document unvalidated.
 * @returns {string[]} One sentence per unusable list. Empty means every ratchet list is
 *   a list of keys of its own spelling — never a "the baseline is valid" verdict, which
 *   is {@link loadBaseline}'s to give.
 */
function baselineRatchetFaults(parsed) {
  const faults = [];
  for (const graph of RECORDED_GRAPHS) {
    const declared = ratchetList(parsed, graph.declaredCyclesPath);
    if (!Array.isArray(declared)) {
      faults.push(`${graph.declaredCyclesPath} is missing or not an array`);
      continue;
    }
    const index = declared.findIndex(
      (component) =>
        !Array.isArray(component) || component.some((node) => typeof node !== "string"),
    );
    if (index !== -1) {
      faults.push(
        `${graph.declaredCyclesPath}[${index}] is not a list of node names: ${JSON.stringify(declared[index])}`,
      );
    }
  }
  for (const ratchet of BASELINE_RATCHETS) {
    const value = ratchetList(parsed, ratchet.path);
    if (!Array.isArray(value)) {
      faults.push(`${ratchet.path} is missing or not an array`);
      continue;
    }
    const index = value.findIndex((entry) => typeof entry !== "string");
    if (index !== -1) {
      faults.push(`${ratchet.path}[${index}] is ${typeof value[index]}, not a string`);
      continue;
    }
    if (ratchet.memberKind !== "edgeKey") continue;
    const malformed = value.findIndex((entry) => {
      const sides = entry.split(" -> ");
      return sides.length !== 2 || sides[0].length === 0 || sides[1].length === 0;
    });
    if (malformed !== -1) {
      faults.push(
        `${ratchet.path}[${malformed}] is not an edge key: ${JSON.stringify(value[malformed])}`,
      );
    }
  }
  return faults;
}

/**
 * Every recorded graph that PERMITS a cycle it does not DECLARE, as one sentence naming
 * both lists and the components they disagree about.
 *
 * This is what makes the two fields of a recorded graph hold each other. A single writer
 * emits `edges` and `sccs` from ONE {@link collectArchitecture} snapshot through
 * {@link graphFromEdges}, so they agree by construction, always. A union of two writers
 * cannot: two branches that each regenerate from an individually accepted tree both emit
 * `sccs: []` — an accepted tree has no new cycle — while their merged `edges` lists hold
 * a component neither branch recorded. The keys sort far apart in the file, so git merges
 * both without a conflict, and no merge tool is involved in catching it: the merged FILE
 * is internally inconsistent, so the fault is reported wherever that file is read, which
 * includes CI on the merge ref.
 *
 * Two clauses, and the second is not redundant. (a) The components the recorded edges
 * form must be exactly the declared ones — an equality, so a stale declaration is caught
 * with the same reading as an undeclared cycle. (b) Every cyclic recorded edge must sit
 * in a declared component, which is what covers a SELF-LOOP: {@link cyclicEdgeKeys}
 * counts `a -> a` as cyclic while {@link graphFromEdges} filters length-1 components out,
 * so `"a -> a"` is a permission clause (a) cannot see. Both collectors drop self-edges at
 * the push site, so no GENERATED file holds one; (b) is there for the hand edit a refusal
 * invites.
 *
 * The derived side goes through {@link graphFromEdges} and {@link cyclicEdgeKeysOf}, the
 * same two spellings of the SCC pass the live check uses, so this adds no third traversal
 * whose agreement with the other two would need its own drive.
 */
function baselineSelfPermissionFaults(parsed) {
  const faults = [];
  for (const graph of RECORDED_GRAPHS) {
    const edges = ratchetList(parsed, graph.path);
    const declared = ratchetList(parsed, graph.declaredCyclesPath);
    const derived = graphFromEdges([], edgesFromKeys(edges)).sccs;
    if (JSON.stringify(derived) !== JSON.stringify(declared)) {
      faults.push(
        `${graph.path} forms ${JSON.stringify(derived)}, but ${graph.declaredCyclesPath} declares ${JSON.stringify(declared)}`,
      );
      continue;
    }
    const declaredNodes = new Set(declared.flat());
    const undeclared = cyclicEdgeKeysOf(edges).filter(
      (key) => !declaredNodes.has(key.split(" -> ")[0]),
    );
    if (undeclared.length > 0) {
      faults.push(
        `${graph.path} permits ${JSON.stringify(undeclared)}, which lies in no component ${graph.declaredCyclesPath} declares`,
      );
    }
  }
  return faults;
}

/**
 * What regenerating the baseline would add to and remove from each ratchet.
 *
 * One channel per {@link BASELINE_RATCHETS} row, in table order, reading the SAME dotted
 * path out of the committed baseline and the emitted document. A channel that read two
 * different ratchets' lists would print a delta for a list nobody changed, and
 * `--write-baseline` reports this to a human as the only account of what it is about to
 * write.
 */
function baselineDelta(baseline, document) {
  return Object.fromEntries(
    BASELINE_RATCHETS.map((ratchet) => [
      ratchet.channel,
      listDelta(ratchetList(baseline, ratchet.path), ratchetList(document, ratchet.path)),
    ]),
  );
}

/**
 * Decide whether `--write-baseline` may regenerate the file, and report what
 * regenerating would change.
 *
 * {@link baselineDocument} re-derives EVERY ratchet in the file from the current
 * tree: the two cycle allowlists AND both `legacyExceptions` import lists. So an
 * unguarded regeneration from a tree that already violates the check writes those
 * violations into the file as tomorrow's permissions — the flag launders three
 * ratchets, not one. Refusing on ANY violation (not only cycle violations) keeps the
 * emitted document a subset of what the committed baseline already permits.
 *
 * That subset argument holds for ONE writer at a time, and only for one. Two branches
 * that each regenerate from an individually accepted tree merge into a file that
 * permits a cycle neither branch permitted: the two edge keys sort far apart in the
 * JSON array, so git auto-merges both without a conflict, and the SCC pass over the
 * union finds a component that is in neither record. `legacyExceptions.*.imports` is a
 * pure allowlist that can only shrink, so a union of deletions is merge-safe; the two
 * graph lists are records that grow freely whose permission is a NON-MONOTONE function
 * of the record, so a union of additions is not. This hole is older than this guard —
 * the same merge is clean against the unguarded flag.
 *
 * What closes it is {@link baselineSelfPermissionFaults}, one layer down in
 * {@link loadBaseline}: the union file is internally inconsistent, so it is refused
 * before this function sees it, by every path that reads the file and on the merge ref
 * in CI. That refusal covers this flag too, deliberately — regenerating from a
 * self-permitting baseline would launder the union into a legitimately declared cycle,
 * because the check would already have accepted the merged tree against it.
 *
 * A refusal carries no `document` and no `delta`, so there is nothing for a future
 * caller to write by forgetting one `if`. That is a property of the return TYPE below,
 * not of this sentence: `scripts/tsconfig.json` type-checks this file, and reading
 * either field without first narrowing on `ok` does not compile.
 *
 * The literal `ok` in each member is what buys that. Without the annotation TypeScript
 * widens the `ok` of a fresh object literal to `boolean`, the return type stops being a
 * discriminated union, and the narrowing this function's whole safety argument rests on
 * silently does nothing.
 *
 * @typedef {{ok: false, violations: string[]}} BaselineEmissionRefusal
 * @typedef {{ok: true, violations: string[], document: ReturnType<typeof baselineDocument>, delta: ReturnType<typeof baselineDelta>}} BaselineEmissionAcceptance
 *
 * @param {ReturnType<typeof collectArchitecture>} architecture
 * @param {unknown} baseline The `baseline` of an accepted {@link loadBaseline} read.
 * @returns {BaselineEmissionRefusal | BaselineEmissionAcceptance}
 */
function baselineEmission(architecture, baseline) {
  const violations = checkArchitecture(architecture, baseline);
  if (violations.length > 0) return { ok: false, violations };
  const document = baselineDocument(architecture);
  return { ok: true, violations, document, delta: baselineDelta(baseline, document) };
}

function selfTestFailures() {
  const failures = [];
  const parsed = parseImports(`
// import "ignored-comment";
import type { A } from "../a";
export { B } from "../b";
import C = require("../c");
const d = import("../d");
const e = require("../e");
const dynamic = import(variable);
const text = 'import "ignored-string"';
`);
  const actualSpecifiers = parsed.map((entry) => entry.specifier);
  const expectedSpecifiers = ["../a", "../b", "../c", "../d", "../e"];
  if (JSON.stringify(actualSpecifiers) !== JSON.stringify(expectedSpecifiers)) {
    failures.push(
      `parser fixture mismatch: expected ${JSON.stringify(expectedSpecifiers)}, received ${JSON.stringify(actualSpecifiers)}`,
    );
  }

  const components = stronglyConnectedComponents(
    ["a", "b", "c", "d"],
    [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ],
  );
  if (JSON.stringify(components) !== JSON.stringify([["a", "b"], ["c"], ["d"]])) {
    failures.push(`SCC fixture mismatch: received ${JSON.stringify(components)}`);
  }

  // Execution forbidden-import gate (item 06): the rule must FIRE on a live
  // `execution -> triage` edge and stay SILENT on a non-product edge like
  // `execution -> integrations`, independent of any baseline.
  const forbiddenFired = executionForbiddenImportViolations([{ from: "execution", to: "triage" }]);
  if (!forbiddenFired.some((violation) => violation.includes("execution -> triage"))) {
    failures.push(
      `execution forbidden-import fixture mismatch: expected an execution -> triage violation, received ${JSON.stringify(forbiddenFired)}`,
    );
  }
  // Each locked module carries its own live fixture (item 11): `workflows` is
  // the last product edge the execution core shed (item 10), so prove the gate
  // fires for `execution -> workflows` too, not just `execution -> triage`.
  const forbiddenFiredWorkflows = executionForbiddenImportViolations([
    { from: "execution", to: "workflows" },
  ]);
  if (!forbiddenFiredWorkflows.some((violation) => violation.includes("execution -> workflows"))) {
    failures.push(
      `execution forbidden-import fixture mismatch: expected an execution -> workflows violation, received ${JSON.stringify(forbiddenFiredWorkflows)}`,
    );
  }
  const forbiddenSilent = executionForbiddenImportViolations([
    { from: "execution", to: "integrations" },
  ]);
  if (forbiddenSilent.length > 0) {
    failures.push(
      `execution forbidden-import fixture mismatch: expected no violation for execution -> integrations, received ${JSON.stringify(forbiddenSilent)}`,
    );
  }

  // Wiring self-test (item 11): the fixtures above prove the pure predicates, not
  // that they are wired into `checkArchitecture`. Drive synthetic graphs through
  // `checkArchitecture` ITSELF so a deleted `violations.push(...)` line turns this
  // red — the live graph has no forbidden edge, and post-rename no missing node,
  // to catch either regression on its own. `checkArchitecture` is pure over its two
  // arguments (item 38), so a drive sees exactly what its synthetic architecture
  // plants.
  // Both graphs carry `sccs` because a well-formed baseline does: `baselineRatchetFaults`
  // refuses a recorded graph that declares no cycle list, and
  // `baselineSelfPermissionFaults` reads it. Drives that hand `checkArchitecture` or
  // `baselineDelta` an override without one still work — neither reads it.
  const syntheticBaseline = (overrides) => ({
    packageGraph: { edges: [], sccs: [] },
    assistantModuleGraph: { edges: [], sccs: [] },
    legacyExceptions: {
      privateModuleImports: { imports: [] },
      webFeatureImports: { imports: [] },
    },
    ...overrides,
  });
  // The four tree-derived fields default INERT — an empty presence list, no composition
  // sources, a null manifest, an empty barrel walk with an empty forbidden list, no boot-seam
  // sources. That is what makes every drive below a decision over its own plant and nothing
  // else. An inert barrel walk is why `connectionsBarrelReachViolations` does not assert its
  // own liveness: a "the walk found more than the barrel" check here would fire on every
  // drive of every other rule. That assertion is `(f-b)`, over the real tree.
  const syntheticArchitecture = (overrides) => ({
    packageGraph: { edges: [] },
    moduleGraph: { edges: [] },
    moduleNodes: [],
    exceptions: { privateModuleImports: [], webFeatureImports: [] },
    forbiddenBackendImports: [],
    productionPreviewImports: [],
    scannedPaths: [],
    runtimeAdapterScan: { compositionSources: [], manifestSource: null },
    connectionsBarrelReach: { reached: [], forbidden: [] },
    bootSeamSources: [],
    workspaceFailures: [],
    ...overrides,
  });
  // (0) A refused workspace enumeration must reach the violation list. The live
  // enumeration is clean, so nothing else here would notice the wiring going away —
  // and a checker that walked a partial workspace list would report every absence
  // in it as a clean graph.
  const workspaceWiringDrive = checkArchitecture(
    syntheticArchitecture({ workspaceFailures: ["pnpm-workspace.yaml does not exist"] }),
    syntheticBaseline(),
  );
  if (!workspaceWiringDrive.some((violation) => violation.includes("workspace enumeration:"))) {
    failures.push(
      `workspace-enumeration wiring self-test mismatch: expected checkArchitecture to report a refused enumeration, received ${JSON.stringify(workspaceWiringDrive)}`,
    );
  }
  // (0-b) A collected assistant -> transport import must reach the violation list.
  // This is ADR-0089's fence — `@alfred/assistant` must never import `@alfred/http`,
  // legacy `@alfred/api` or `apps/server` — and this loop is its only enforcement.
  // The live tree holds zero members, so deleting the push left every gate green.
  // The key and line conjuncts fail a body that pushes a constant or reads the wrong
  // member field, which a deletion mutant alone would not catch.
  const assistantBackendFenceWiringDrive = checkArchitecture(
    syntheticArchitecture({
      forbiddenBackendImports: [
        { key: "packages/assistant/src/triage/self-test-fixture.ts:@alfred/http", line: 7 },
      ],
    }),
    syntheticBaseline(),
  );
  if (
    !assistantBackendFenceWiringDrive.some(
      (violation) =>
        violation.includes("assistant imports transport or app code:") &&
        violation.includes("@alfred/http") &&
        violation.includes("line 7"),
    )
  ) {
    failures.push(
      `assistant-backend-fence wiring self-test mismatch: expected checkArchitecture to report the planted assistant -> transport import with its key and line, received ${JSON.stringify(assistantBackendFenceWiringDrive)}`,
    );
  }
  // (0-c) The production -> preview fence, same shape one list over. Also zero
  // members in the live tree, also deletable green before this drive existed.
  const productionPreviewWiringDrive = checkArchitecture(
    syntheticArchitecture({
      productionPreviewImports: [
        { key: "apps/web/src/features/inbox/self-test-fixture.tsx:../debug/panel", line: 11 },
      ],
    }),
    syntheticBaseline(),
  );
  if (
    !productionPreviewWiringDrive.some(
      (violation) =>
        violation.includes("production imports preview/debug code:") &&
        violation.includes("../debug/panel") &&
        violation.includes("line 11"),
    )
  ) {
    failures.push(
      `production-preview-fence wiring self-test mismatch: expected checkArchitecture to report the planted production -> preview import with its key and line, received ${JSON.stringify(productionPreviewWiringDrive)}`,
    );
  }
  // (0-d)/(0-e) The COLLECTION half of the same two fences. `(0-b)`/`(0-c)` above drive
  // the REPORT half over a synthetic architecture, so they never run the walk that
  // decides membership. The live tree holds zero members of either list, which means a
  // NARROWED predicate — dropping the `@alfred/api` arm of ADR-0089's fence, dropping
  // `!sourceIsPreview` — collects the same empty list as a correct one and passes every
  // gate, including those two drives. This drive runs the same `collectImportFacts` the
  // production walk runs, over a fixture it plants, so each arm is named by the importer
  // basename that fails when the arm goes away. `collectArchitecture()` itself stays
  // off-limits here for the reason drive `(c)` gives: the self-test runs before
  // collection, and a full workspace walk inside it is not the trade.
  //
  // The fixture is written under the system temp directory, never in the repository —
  // the same shape drive `(xiii-e)` uses. A deliberately-violating tracked file would be
  // seen by `tsc`, `knip`, oxlint and this fence on a real run; a fixture inside
  // `apps/web/src/routes` would make every `pnpm check` mutate a tracked directory and
  // would leave a violating file behind if the process died mid-run.
  // Shared by `(0-d)`/`(0-e)` and `(0-f)`: one fixture file, whose single import sits on
  // line 1 so a drive can assert the collected line number. Every fixture path a caller
  // builds is assembled segment-wise off its own `mkdtemp` root and no segment is a
  // tracked top-level directory, so none of those literals is a repo path literal that
  // `check:script-paths` would resolve and refuse.
  const plant = (path, specifier) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      specifier === null
        ? "export const leaf = 1;\n"
        : `import { leaf } from "${specifier}";\n\nexport const reexported = leaf;\n`,
    );
  };
  const importFactsDirectory = mkdtempSync(join(tmpdir(), "check-module-architecture-"));
  try {
    const assistantRoot = join(importFactsDirectory, "assistant");
    const serverRoot = join(importFactsDirectory, "server");
    const webRoot = join(importFactsDirectory, "web");
    const fixtureRoutesRoot = join(webRoot, "src", "routes");
    plant(join(assistantRoot, "fence-http-exact.ts"), "@alfred/http");
    plant(join(assistantRoot, "fence-http-subpath.ts"), "@alfred/http/routes");
    plant(join(assistantRoot, "fence-api-exact.ts"), "@alfred/api");
    plant(join(assistantRoot, "fence-api-subpath.ts"), "@alfred/api/context");
    plant(join(assistantRoot, "fence-server-relative.ts"), "../server/handler.ts");
    plant(join(serverRoot, "server-imports-transport.ts"), "@alfred/http");
    plant(join(serverRoot, "handler.ts"), null);
    plant(join(fixtureRoutesRoot, "-inbox", "production-to-debug.tsx"), "../-debug/panel.tsx");
    plant(
      join(fixtureRoutesRoot, "-inbox", "production-to-preview.tsx"),
      "../-preview-panel/panel.tsx",
    );
    plant(
      join(fixtureRoutesRoot, "-inbox", "production-to-production.tsx"),
      "../-settings/panel.tsx",
    );
    plant(join(fixtureRoutesRoot, "-debug", "debug-to-preview.tsx"), "../-preview-panel/panel.tsx");
    plant(join(fixtureRoutesRoot, "-preview-panel", "preview-to-debug.tsx"), "../-debug/panel.tsx");
    plant(join(fixtureRoutesRoot, "debug.route-file.tsx"), "./-debug/panel.tsx");
    plant(join(fixtureRoutesRoot, "-debug", "panel.tsx"), null);
    plant(join(fixtureRoutesRoot, "-preview-panel", "panel.tsx"), null);
    plant(join(fixtureRoutesRoot, "-settings", "panel.tsx"), null);
    // Three synthetic entries, so the fence's `entry.name === "@alfred/assistant"` gate
    // and the preview predicate's `entry.name === "web"` gate cannot cross-contaminate.
    // This call takes `moduleRoots`' default, i.e. the real repository roots, and the
    // fixture plants no module tree under either of them — so it contributes no module
    // edge and no private import, and drive `(0-f)` below owns those two lists.
    const importFacts = collectImportFacts(
      [
        { directory: assistantRoot, name: "@alfred/assistant", source: assistantRoot },
        { directory: serverRoot, name: "server", source: serverRoot },
        { directory: webRoot, name: "web", source: join(webRoot, "src") },
      ],
      fixtureRoutesRoot,
    );
    // (0-d) One arm of the assistant -> transport specifier test per row, so a narrowed
    // fence fails by the arm it dropped rather than as "some list is empty".
    for (const [importerBasename, arm] of [
      ["fence-http-exact", "the exact `@alfred/http` specifier"],
      ["fence-http-subpath", "an `@alfred/http/` subpath specifier"],
      ["fence-api-exact", "the exact legacy `@alfred/api` specifier"],
      ["fence-api-subpath", "an `@alfred/api/` subpath specifier"],
      ["fence-server-relative", "a relative import that resolves into the `server` entry"],
    ]) {
      if (
        !importFacts.forbiddenBackendImports.some((imported) =>
          imported.key.includes(importerBasename),
        )
      ) {
        failures.push(
          `assistant-backend-fence collection self-test mismatch: expected the import walk to collect ${importerBasename} for ${arm}, received ${JSON.stringify(importFacts.forbiddenBackendImports)}`,
        );
      }
    }
    if (
      importFacts.forbiddenBackendImports.some((imported) =>
        imported.key.includes("server-imports-transport"),
      )
    ) {
      failures.push(
        `assistant-backend-fence collection self-test mismatch: expected the import walk to leave server-imports-transport uncollected, because the fence applies to the \`@alfred/assistant\` entry alone, received ${JSON.stringify(importFacts.forbiddenBackendImports)}`,
      );
    }
    // (0-e) The production -> preview predicate, both directions. The two positives cover
    // `targetIsPreview`'s `debug` and `preview-` arms; the three negatives cover
    // `targetIsPreview` refusing a production target and `!sourceIsPreview` refusing each
    // of the three ways a source is itself preview code.
    for (const [importerBasename, arm] of [
      ["production-to-debug", "a production route importing the `-debug` feature"],
      ["production-to-preview", "a production route importing a `-preview-` feature"],
    ]) {
      if (
        !importFacts.productionPreviewImports.some((imported) =>
          imported.key.includes(importerBasename),
        )
      ) {
        failures.push(
          `production-preview-fence collection self-test mismatch: expected the import walk to collect ${importerBasename} for ${arm}, received ${JSON.stringify(importFacts.productionPreviewImports)}`,
        );
      }
    }
    for (const [importerBasename, reason] of [
      ["production-to-production", "its target is not preview or debug code"],
      ["debug-to-preview", "its source is the `-debug` feature"],
      ["preview-to-debug", "its source is a `-preview-` feature"],
      ["debug.route-file", "its source is a `debug.`-prefixed route file"],
    ]) {
      if (
        importFacts.productionPreviewImports.some((imported) =>
          imported.key.includes(importerBasename),
        )
      ) {
        failures.push(
          `production-preview-fence collection self-test mismatch: expected the import walk to leave ${importerBasename} uncollected, because ${reason}, received ${JSON.stringify(importFacts.productionPreviewImports)}`,
        );
      }
    }
  } finally {
    rmSync(importFactsDirectory, { force: true, recursive: true });
  }
  // (0-f) The COLLECTION half of ADR-0089's private cross-module import fence. `(0-b)`
  // and the report loop drive the message, over a synthetic architecture that already
  // holds the record — so nothing there runs the predicate that decides which imports
  // become records, and a NARROWED predicate collects a shorter list that every
  // baselined key still covers, leaving every gate green. The fence used to require the
  // IMPORTING file to live in a module directory too, which exempted every wiring file
  // in `packages/api/src`, `packages/http` and `apps/server` — the files that reach
  // across modules for a living. This drive names each importer position separately, so
  // re-gating on `fromModule` fails by the position it dropped rather than as "the list
  // got shorter".
  //
  // `moduleRoots` is the parameter this rides: the fixture plants a module tree under
  // its own `mkdtemp` root, the same way `(0-d)`/`(0-e)` plant a route tree, so the
  // walk under test is the production `collectImportFacts` and not a copy of it.
  const moduleReachDirectory = mkdtempSync(join(tmpdir(), "check-module-architecture-"));
  try {
    const apiRoot = join(moduleReachDirectory, "api");
    const assistantRoot = join(moduleReachDirectory, "assistant");
    const serverRoot = join(moduleReachDirectory, "server");
    const apiSourceRoot = join(apiRoot, "src");
    const assistantSourceRoot = join(assistantRoot, "src");
    const serverSourceRoot = join(serverRoot, "src");
    const apiModulesRoot = join(apiSourceRoot, "modules");
    const fixtureModuleRoots = { apiModules: apiModulesRoot, assistantSource: assistantSourceRoot };
    // Every `plant` path below is built off `moduleReachDirectory`, never off
    // `fixtureModuleRoots` — the roots object is what a mutant repoints, and a plant that
    // read it would write a fixture into the real `packages/api/src/modules` tree.
    plant(join(apiModulesRoot, "connections", "store.ts"), null);
    plant(join(apiModulesRoot, "skills", "index.ts"), null);
    // `triage` and `knowledge` are real `TARGET_ASSISTANT_MODULES` members, so the module
    // name Set needs no parameter of its own; `not-a-module` deliberately is not one.
    plant(join(assistantSourceRoot, "triage", "internal.ts"), null);
    plant(join(assistantSourceRoot, "knowledge", "internal.ts"), null);
    // One importer per position a private reach can come from.
    plant(join(apiSourceRoot, "runtime-reach.ts"), "./modules/connections/store.ts");
    plant(join(serverSourceRoot, "wire-reach.ts"), "../../api/src/modules/connections/store.ts");
    plant(join(assistantSourceRoot, "not-a-module", "outside-module.ts"), "../triage/internal.ts");
    plant(join(assistantSourceRoot, "triage", "module-reach.ts"), "../knowledge/internal.ts");
    // One importer per way an import into a module directory stays public.
    plant(join(apiSourceRoot, "runtime-barrel.ts"), "./modules/skills/index.ts");
    plant(join(serverSourceRoot, "wire-barrel.ts"), "../../api/src/modules/skills/index.ts");
    plant(join(assistantSourceRoot, "triage", "intra-flat.ts"), "./internal.ts");
    plant(join(assistantSourceRoot, "triage", "nested", "intra-deep.ts"), "../internal.ts");
    const moduleReachFacts = collectImportFacts(
      [
        { directory: apiRoot, name: "@alfred/api", source: apiSourceRoot },
        { directory: assistantRoot, name: "@alfred/assistant", source: assistantSourceRoot },
        { directory: serverRoot, name: "server", source: serverSourceRoot },
      ],
      WEB_ROUTES_ROOT,
      fixtureModuleRoots,
    );
    const privateReaches = moduleReachFacts.exceptions.privateModuleImports;
    for (const [importerBasename, position] of [
      ["runtime-reach", "a non-module file reaching into a module of its own package"],
      ["wire-reach", "a non-module file in another package reaching around into a module"],
      ["outside-module", "a file inside the assistant source root but outside any target module"],
      ["module-reach", "a module file reaching into another module"],
    ]) {
      if (!privateReaches.some((imported) => imported.key.includes(`${importerBasename}.ts`))) {
        failures.push(
          `private-module-import fence collection self-test mismatch: expected the import walk to collect ${importerBasename} for ${position}, received ${JSON.stringify(privateReaches)}`,
        );
      }
    }
    for (const [importerBasename, reason] of [
      ["runtime-barrel", "it addresses the module through its own `index.ts`"],
      ["wire-barrel", "a barrel import is public from another package too"],
      ["intra-flat", "the importer lives in the module it imports"],
      ["intra-deep", "the importer lives in a subdirectory of the module it imports"],
    ]) {
      if (privateReaches.some((imported) => imported.key.includes(`${importerBasename}.ts`))) {
        failures.push(
          `private-module-import fence collection self-test mismatch: expected the import walk to leave ${importerBasename} uncollected, because ${reason}, received ${JSON.stringify(privateReaches)}`,
        );
      }
    }
    // Every reported field on one row per `from` arm, because a deletion-only matrix
    // leaves a stubbed field green. `from` is the importer's owning scope: its module
    // when it has one, otherwise its package name.
    for (const expected of [
      { from: "@alfred/api", importer: "runtime-reach.ts", line: 1, to: "connections" },
      { from: "triage", importer: "module-reach.ts", line: 1, to: "knowledge" },
    ]) {
      const reach = privateReaches.find((imported) => imported.key.includes(expected.importer));
      if (
        reach &&
        (reach.from !== expected.from || reach.to !== expected.to || reach.line !== expected.line)
      ) {
        failures.push(
          `private-module-import fence collection self-test mismatch: expected ${expected.importer} to be collected as from ${expected.from} -> ${expected.to} at line ${expected.line}, received ${JSON.stringify(reach)}`,
        );
      }
    }
  } finally {
    rmSync(moduleReachDirectory, { force: true, recursive: true });
  }
  // (0-g) The connections-barrel forbidden-reach rule, red case (item 52). A walk that reached
  // a forbidden target must reach the violation list, and must carry the CHAIN — "the barrel
  // reaches queue.ts" names nothing to delete. The reached file is built from the real
  // constant, not from a path literal, so repointing `CONNECTIONS_BARREL_FORBIDDEN_REACH` at a
  // module this rule was never meant to guard fails here rather than passing quietly.
  const barrelReachRedDrive = checkArchitecture(
    syntheticArchitecture({
      connectionsBarrelReach: {
        reached: [
          {
            chain: "index.ts -> ingestion/index.ts -> queue.ts",
            file: CONNECTIONS_BARREL_FORBIDDEN_REACH[0],
          },
        ],
        forbidden: CONNECTIONS_BARREL_FORBIDDEN_REACH.map((path) => ({ path, present: true })),
      },
    }),
    syntheticBaseline(),
  );
  if (
    !barrelReachRedDrive.some(
      (violation) =>
        violation.includes("connections barrel reaches forbidden ingestion module:") &&
        violation.includes("index.ts -> ingestion/index.ts -> queue.ts"),
    )
  ) {
    failures.push(
      `connections-barrel reach self-test mismatch: expected checkArchitecture to report the planted reach with its importer chain, received ${JSON.stringify(barrelReachRedDrive)}`,
    );
  }
  // (0-h) The liveness half, and the drive whose expected outcome DIFFERS from (0-g)'s: a
  // forbidden target that is not a file forbids nothing, so it is reported by constant name
  // rather than ignored. Swapping this drive's expected message with (0-g)'s must redden both;
  // a deletion matrix alone leaves each message bound to no particular subject.
  const barrelReachLivenessDrive = checkArchitecture(
    syntheticArchitecture({
      connectionsBarrelReach: {
        reached: [],
        forbidden: [{ path: "/self-test/renamed-queue.ts", present: false }],
      },
    }),
    syntheticBaseline(),
  );
  if (
    !barrelReachLivenessDrive.some(
      (violation) =>
        violation.includes("connections barrel forbidden-reach target is not a file:") &&
        violation.includes("CONNECTIONS_BARREL_FORBIDDEN_REACH"),
    )
  ) {
    failures.push(
      `connections-barrel reach self-test mismatch: expected checkArchitecture to report an absent forbidden target by constant name, received ${JSON.stringify(barrelReachLivenessDrive)}`,
    );
  }
  // (0-i) The green case. Without it (0-g) also passes for a rule that reports every reached
  // file, which would redden the ten files the barrel legitimately reaches — including
  // `ingestion/workflow-recovery`, the leaf `oauth-state` imports on purpose.
  const barrelReachGreenDrive = checkArchitecture(
    syntheticArchitecture({
      connectionsBarrelReach: {
        reached: [{ chain: "index.ts -> oauth-state.ts", file: "/self-test/oauth-state.ts" }],
        forbidden: CONNECTIONS_BARREL_FORBIDDEN_REACH.map((path) => ({ path, present: true })),
      },
    }),
    syntheticBaseline(),
  );
  if (barrelReachGreenDrive.some((violation) => violation.includes("connections barrel"))) {
    failures.push(
      `connections-barrel reach self-test mismatch: expected no violation for a walk that reached no forbidden target, received ${JSON.stringify(barrelReachGreenDrive)}`,
    );
  }
  // (i) A live `agent -> triage` edge with a self-consistent node set must make
  // `checkArchitecture` report the forbidden product import — guards the wiring
  // of the forbidden-import push.
  const forbiddenWiringDrive = checkArchitecture(
    syntheticArchitecture({
      moduleGraph: { edges: ["execution -> triage"] },
      moduleNodes: ["execution", "triage"],
    }),
    syntheticBaseline(),
  );
  if (
    !forbiddenWiringDrive.some((violation) =>
      violation.includes("execution imports forbidden product module"),
    )
  ) {
    failures.push(
      `execution forbidden-import wiring self-test mismatch: expected checkArchitecture to report a forbidden product import for agent -> triage, received ${JSON.stringify(forbiddenWiringDrive)}`,
    );
  }
  // (ii) A node set that omits EXECUTION_MODULE and the forbidden entry must make
  // `checkArchitecture` report the "unknown module" liveness violation — guards
  // the wiring of the liveness push (the Phase-6 rename / typo defense).
  const livenessWiringDrive = checkArchitecture(
    syntheticArchitecture({ moduleNodes: ["chat"] }),
    syntheticBaseline(),
  );
  if (
    !livenessWiringDrive.some((violation) =>
      violation.includes("execution gate references unknown module"),
    )
  ) {
    failures.push(
      `execution gate liveness wiring self-test mismatch: expected checkArchitecture to report an unknown-module violation when the live graph omits "${EXECUTION_MODULE}", received ${JSON.stringify(livenessWiringDrive)}`,
    );
  }
  // (iii) A node set that lists EXECUTION_MODULE but omits the forbidden entry
  // isolates the forbidden-set liveness branch: branch A stays silent (the module
  // is live), so only branch B can produce the "forbidden set references unknown
  // module" violation. This guards the per-entry loop (the "traige" typo defense)
  // on its own — without it the loop is silently deletable, since drive (ii) and
  // the real check both stay green when it is removed.
  const forbiddenSetLivenessDrive = checkArchitecture(
    syntheticArchitecture({ moduleNodes: [EXECUTION_MODULE] }),
    syntheticBaseline(),
  );
  if (
    !forbiddenSetLivenessDrive.some((violation) =>
      violation.includes("execution gate forbidden set references unknown module"),
    )
  ) {
    failures.push(
      `execution gate forbidden-set liveness self-test mismatch: expected checkArchitecture to report a forbidden-set unknown-module violation when the live graph lists "${EXECUTION_MODULE}" but omits a forbidden entry, received ${JSON.stringify(forbiddenSetLivenessDrive)}`,
    );
  }

  // Baseline-as-cycle-allowlist drives (item 15). The recorded graph is a
  // full-graph mirror consulted as a cycle allowlist, so the comparison must run
  // over the baseline's CYCLIC SUBSET. Today's real baseline permits ZERO cycles in
  // both graphs, so nothing observable changes on the live tree — these synthetic
  // drives are the only evidence the rule does anything, and (iv) is the one that
  // was red before the fix.
  //
  // (iv) A live two-node cycle whose FORWARD direction sits in the baseline must be
  // reported in BOTH directions: `a -> b` was recorded as ordinary acyclic debt and
  // must not double as a permission slip now that it has joined a cycle.
  const partialCyclePackageDrive = checkArchitecture(
    syntheticArchitecture({ packageGraph: { edges: ["a -> b", "b -> a"] } }),
    syntheticBaseline({ packageGraph: { edges: ["a -> b"] } }),
  );
  for (const edge of ["a -> b", "b -> a"]) {
    if (!partialCyclePackageDrive.includes(`new cyclic package edge: ${edge}`)) {
      failures.push(
        `baseline cycle-allowlist self-test mismatch: expected checkArchitecture to report "new cyclic package edge: ${edge}" when the baseline records only the acyclic direction, received ${JSON.stringify(partialCyclePackageDrive)}`,
      );
    }
  }
  // (v) The same shape on the assistant-module graph — the two comparisons are
  // separate `Set`s, so each needs its own drive.
  const partialCycleModuleDrive = checkArchitecture(
    syntheticArchitecture({ moduleGraph: { edges: ["a -> b", "b -> a"] } }),
    syntheticBaseline({ assistantModuleGraph: { edges: ["a -> b"] } }),
  );
  for (const edge of ["a -> b", "b -> a"]) {
    if (!partialCycleModuleDrive.includes(`new cyclic assistant-module edge: ${edge}`)) {
      failures.push(
        `baseline cycle-allowlist self-test mismatch: expected checkArchitecture to report "new cyclic assistant-module edge: ${edge}" when the baseline records only the acyclic direction, received ${JSON.stringify(partialCycleModuleDrive)}`,
      );
    }
  }
  // (vi) The tightening must not over-fire: a cycle the baseline records in BOTH
  // directions is still permitted, so no `new cyclic package edge` may appear.
  const permittedCycleDrive = checkArchitecture(
    syntheticArchitecture({ packageGraph: { edges: ["a -> b", "b -> a"] } }),
    syntheticBaseline({ packageGraph: { edges: ["a -> b", "b -> a"] } }),
  );
  if (permittedCycleDrive.some((violation) => violation.includes("new cyclic package edge"))) {
    failures.push(
      `baseline cycle-allowlist self-test mismatch: expected no new-cyclic-package-edge violation when the baseline records the whole cycle, received ${JSON.stringify(permittedCycleDrive)}`,
    );
  }

  // `--write-baseline` emission drives (item 15). The CLI wiring itself is tier 3
  // (nothing in the repo runs the flag), so `baselineEmission` is where the
  // refuse-vs-emit decision is pinned, and `baselineDocument`/`baselineDelta` are
  // where its payload is.
  const liveModuleNodes = [EXECUTION_MODULE, ...EXECUTION_FORBIDDEN_PRODUCT_MODULES];
  // (vii) A tree with a cycle the baseline does not permit must REFUSE, and a refusal
  // must carry no writable payload, so a regeneration cannot write that cycle into
  // the allowlist.
  const refusedEmission = baselineEmission(
    syntheticArchitecture({
      packageGraph: { edges: ["a -> b", "b -> a"] },
      moduleNodes: liveModuleNodes,
    }),
    syntheticBaseline(),
  );
  // `Object.hasOwn` rather than a `!== undefined` read: the return type now declares
  // both fields ABSENT from a refusal, so reading either one off this value no longer
  // compiles. This holds the runtime object to the same claim the type makes — a
  // present-but-`undefined` key would satisfy the old comparison and contradict it.
  const refusedPayloadKeys = ["document", "delta"].filter((key) =>
    Object.hasOwn(refusedEmission, key),
  );
  if (
    refusedEmission.ok ||
    refusedPayloadKeys.length > 0 ||
    !refusedEmission.violations.some((violation) =>
      violation.includes("new cyclic package edge: a -> b"),
    )
  ) {
    failures.push(
      `baseline emission self-test mismatch: expected a payload-free refusal naming the new cyclic edge, received ok=${refusedEmission.ok} payloadKeys=${JSON.stringify(refusedPayloadKeys)} violations=${JSON.stringify(refusedEmission.violations)}`,
    );
  }
  // (viii) A graph the check accepts must not be refused FOR A CYCLE, and it must be
  // ACCEPTED — `ok` true over an empty violation list, not merely consistent with a
  // non-empty one. The exact assertion is valid only because `checkArchitecture` is pure
  // over its arguments (item 38): while it read the real tree, this had to weaken to the
  // tautology `ok === (violations.length === 0)`, which stayed green for an emit/refuse
  // decision pinned shut. The coupling runs the other way too — re-introduce a real-tree
  // read in `checkArchitecture` and an ordinary composition violation surfaces here as
  // "parser self-test failed", taking `--print-graph` and `--write-baseline` with it.
  const acceptedEmission = baselineEmission(
    syntheticArchitecture({
      packageGraph: { edges: ["a -> b"], sccs: [] },
      moduleNodes: liveModuleNodes,
    }),
    syntheticBaseline({ packageGraph: { edges: ["a -> b"] } }),
  );
  if (!acceptedEmission.ok || acceptedEmission.violations.length !== 0) {
    failures.push(
      `baseline emission self-test mismatch: expected an accepted emission over an empty violation list, received ok=${acceptedEmission.ok} violations=${JSON.stringify(acceptedEmission.violations)}`,
    );
  }
  // (viii-b) The emitted document is the CURRENT graph. Driven through
  // `baselineDocument` directly, which reads only its argument, so this pin does not
  // depend on the state of the real tree the way `ok` does.
  const emittedDocument = baselineDocument(
    syntheticArchitecture({ packageGraph: { edges: ["a -> b"], sccs: [] } }),
  );
  if (JSON.stringify(emittedDocument.packageGraph.edges) !== JSON.stringify(["a -> b"])) {
    failures.push(
      `baseline document self-test mismatch: expected the emitted document to carry the current package graph, received ${JSON.stringify(emittedDocument.packageGraph.edges)}`,
    );
  }
  if (
    acceptedEmission.ok &&
    JSON.stringify(acceptedEmission.document) !== JSON.stringify(emittedDocument)
  ) {
    failures.push(
      "baseline emission self-test mismatch: an accepted emission must carry exactly the document `baselineDocument` derives from the same architecture",
    );
  }
  // (viii-c) An accepted emission must carry the delta, keyed by every ratchet — the
  // mirror of (vii)'s payload-free refusal. `--write-baseline` reads
  // `Object.entries(emission.delta)` before it writes, so without this drive dropping
  // the field leaves every gate green and kills the command with an uncaught TypeError.
  const deltaRatchetKeys = BASELINE_RATCHETS.map((ratchet) => ratchet.channel);
  if (
    acceptedEmission.ok &&
    deltaRatchetKeys.some((key) => acceptedEmission.delta?.[key] === undefined)
  ) {
    failures.push(
      `baseline emission self-test mismatch: an accepted emission must carry a delta keyed by ${JSON.stringify(deltaRatchetKeys)}, received ${JSON.stringify(acceptedEmission.delta)}`,
    );
  }
  // (ix) The delta must name what regeneration would change, in both directions.
  const packageEdgeDelta = baselineDelta(
    syntheticBaseline({ packageGraph: { edges: ["a -> b", "c -> d"] } }),
    baselineDocument(syntheticArchitecture({ packageGraph: { edges: ["a -> b", "e -> f"] } })),
  ).packageEdges;
  if (
    JSON.stringify(packageEdgeDelta) !== JSON.stringify({ added: ["e -> f"], removed: ["c -> d"] })
  ) {
    failures.push(
      `baseline delta self-test mismatch: expected added ["e -> f"] and removed ["c -> d"], received ${JSON.stringify(packageEdgeDelta)}`,
    );
  }
  // (x) The persisted-shape boundary. `loadBaseline` reads a real path, so the pure
  // half is driven here instead: one drive per fault branch, each asserting a substring
  // no other drive produces.
  const wellFormedFaults = baselineRatchetFaults(syntheticBaseline());
  if (wellFormedFaults.length > 0) {
    failures.push(
      `baseline shape self-test mismatch: expected no fault for a well-formed baseline, received ${JSON.stringify(wellFormedFaults)}`,
    );
  }
  // (x-b) A ratchet list that is absent or of the wrong TYPE.
  const missingListFaults = baselineRatchetFaults(
    syntheticBaseline({ assistantModuleGraph: { edges: "a -> b" } }),
  );
  if (
    !missingListFaults.some(
      (fault) => fault === "assistantModuleGraph.edges is missing or not an array",
    )
  ) {
    failures.push(
      `baseline shape self-test mismatch: expected a fault naming the non-array ratchet list, received ${JSON.stringify(missingListFaults)}`,
    );
  }
  // (x-c) A ratchet list whose MEMBER is not a key. Uncaught before this drive existed:
  // `checkArchitecture` splits every recorded key, so a hand-edited `42` threw a bare
  // `TypeError` out of the middle of the check and of the write flag.
  const memberFaults = baselineRatchetFaults(
    syntheticBaseline({
      legacyExceptions: {
        privateModuleImports: { imports: ["a -> b", 42] },
        webFeatureImports: { imports: [] },
      },
    }),
  );
  if (
    !memberFaults.some(
      (fault) =>
        fault === "legacyExceptions.privateModuleImports.imports[1] is number, not a string",
    )
  ) {
    failures.push(
      `baseline shape self-test mismatch: expected a fault naming the non-string ratchet member and its index, received ${JSON.stringify(memberFaults)}`,
    );
  }

  // Ratchet-set coverage drives (item 35). Everything above drives the CYCLE half of the
  // ratchet set. The other agreements the set rests on were hand-held and undriven:
  // deleting `checkArchitecture`'s `privateModuleImports` comparison, its
  // `webFeatureImports` comparison, or either of two `baselineRatchetFaults` rows left
  // every gate green, and a delta channel could be pointed at another ratchet's list
  // unnoticed. The three drives below turn those agreements into driven properties:
  //
  //  - the document walk enumerates every array `baselineDocument` EMITS and requires
  //    each to be a `BASELINE_RATCHETS` row or a declared derived array, so a fifth
  //    emitted list with no row is red and a row whose list leaves the document is red;
  //  - the per-row loop plants one violating member per ratchet and requires THAT row's
  //    comparison in `checkArchitecture`, the emitted document, the delta channel and the
  //    shape validator each to name it;
  //  - the coverage assertion requires a drive per row and a row per drive.
  //
  // Each assertion below is positive and scoped to a member spelling no other row
  // produces, so one row's drive cannot pass on another row's violation.
  const documentArrayPaths = (value, prefix = "") => {
    if (Array.isArray(value)) return [prefix];
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, child]) =>
      documentArrayPaths(child, prefix === "" ? key : `${prefix}.${key}`),
    );
  };
  // The arrays the emitted document carries that are NOT ratchets: each recorded graph's
  // declared cycle list. It permits nothing — it is derived from `edges` by the same SCC
  // pass the check runs — but it IS read back, by `baselineSelfPermissionFaults`, which
  // requires it to keep agreeing with the edges beside it. Taken from the table, so a
  // graph row that loses its `declaredCyclesPath` turns this walk red instead of silently
  // leaving an emitted array accounted for by nothing. Every other array the document
  // grows must earn a row.
  const derivedDocumentArrays = RECORDED_GRAPHS.map((graph) => graph.declaredCyclesPath);
  // One entry per ratchet channel. `member` is planted in the architecture and must reach
  // the violation, the document and the delta's `added`; `removedMember` is planted in
  // the baseline at the same path and must reach the delta's `removed`, which is what
  // catches a channel reading another ratchet's list; `malformedMember` is a member of
  // this list's OWN spelling that the shape validator must reject.
  const ratchetDrives = {
    packageEdges: {
      member: "ratchet-pkg-a -> ratchet-pkg-b",
      removedMember: "ratchet-pkg-c -> ratchet-pkg-d",
      plant: {
        packageGraph: {
          edges: ["ratchet-pkg-a -> ratchet-pkg-b", "ratchet-pkg-b -> ratchet-pkg-a"],
        },
      },
      reports: "new cyclic package edge: ratchet-pkg-a -> ratchet-pkg-b",
      malformedMember: "ratchet-pkg-a -> ratchet-pkg-b -> ratchet-pkg-c",
      malformedFault:
        'packageGraph.edges[0] is not an edge key: "ratchet-pkg-a -> ratchet-pkg-b -> ratchet-pkg-c"',
    },
    moduleEdges: {
      member: "ratchet-mod-a -> ratchet-mod-b",
      removedMember: "ratchet-mod-c -> ratchet-mod-d",
      plant: {
        moduleGraph: {
          edges: ["ratchet-mod-a -> ratchet-mod-b", "ratchet-mod-b -> ratchet-mod-a"],
        },
      },
      reports: "new cyclic assistant-module edge: ratchet-mod-a -> ratchet-mod-b",
      malformedMember: "ratchet-mod-a -> ",
      malformedFault: 'assistantModuleGraph.edges[0] is not an edge key: "ratchet-mod-a -> "',
    },
    privateModuleImports: {
      member: "packages/ratchet/src/private-drive.ts:../other-module/internal",
      removedMember: "packages/ratchet/src/private-gone.ts:../other-module/internal",
      plant: {
        exceptions: {
          privateModuleImports: [
            {
              key: "packages/ratchet/src/private-drive.ts:../other-module/internal",
              from: "ratchet",
              to: "other-module",
              line: 1,
            },
          ],
          webFeatureImports: [],
        },
      },
      reports:
        "private assistant-module import: packages/ratchet/src/private-drive.ts:../other-module/internal",
      malformedMember: 42,
      malformedFault: "legacyExceptions.privateModuleImports.imports[0] is number, not a string",
    },
    webFeatureImports: {
      member: "apps/web/src/routes/-ratchet/drive.tsx:~/routes/-other-feature/door",
      removedMember: "apps/web/src/routes/-ratchet/gone.tsx:~/routes/-other-feature/door",
      plant: {
        exceptions: {
          privateModuleImports: [],
          webFeatureImports: [
            {
              key: "apps/web/src/routes/-ratchet/drive.tsx:~/routes/-other-feature/door",
              from: "ratchet",
              to: "other-feature",
              line: 1,
            },
          ],
        },
      },
      reports:
        "cross-feature web import: apps/web/src/routes/-ratchet/drive.tsx:~/routes/-other-feature/door",
      malformedMember: 42,
      malformedFault: "legacyExceptions.webFeatureImports.imports[0] is number, not a string",
    },
  };
  // Plant a member list at a table row's own dotted path in an otherwise well-formed
  // synthetic baseline. Derived from the row's `path`, so a renamed ratchet cannot leave
  // a drive pointing at the old spelling. `base` lets a caller plant a second list — a
  // recorded graph is driven through both of its paths at once.
  const baselineWithList = (path, members, base = syntheticBaseline()) => {
    const keys = path.split(".");
    let container = base;
    for (const key of keys.slice(0, -1)) container = container[key];
    container[keys[keys.length - 1]] = members;
    return base;
  };
  const baselineWithGraph = (graph, edges, sccs) =>
    baselineWithList(graph.declaredCyclesPath, sccs, baselineWithList(graph.path, edges));

  // (xi) The document walk: what the document emits and what the table declares are the
  // same set.
  const declaredArrayPaths = new Set([
    ...BASELINE_RATCHETS.map((ratchet) => ratchet.path),
    ...derivedDocumentArrays,
  ]);
  // The two graphs go into the document exactly as `graphFromEdges` built them, so the
  // walk uses that constructor rather than a hand-written mirror of its shape: a
  // synthetic `{ edges: [] }` carries no `sccs`, and the walk would then never see the
  // derived arrays it exists to account for.
  const emittedArrayPaths = documentArrayPaths(
    baselineDocument(
      syntheticArchitecture({
        packageGraph: graphFromEdges([], []),
        moduleGraph: graphFromEdges([], []),
      }),
    ),
  );
  for (const path of emittedArrayPaths) {
    if (declaredArrayPaths.has(path)) continue;
    failures.push(
      `baseline document walk mismatch: the emitted document carries an array at ${path}, which is neither a BASELINE_RATCHETS row nor a declared derived array — nothing validates its shape, compares it against the tree, or names it in the regeneration delta`,
    );
  }
  for (const ratchet of BASELINE_RATCHETS) {
    if (emittedArrayPaths.includes(ratchet.path)) continue;
    failures.push(
      `baseline document walk mismatch: BASELINE_RATCHETS declares ${ratchet.path}, but the emitted document carries no array there, so that ratchet is validated and reported against a list nothing re-derives from the tree`,
    );
  }

  // (xii) One drive per ratchet, each asserting on a member spelling only its own row
  // produces.
  for (const ratchet of BASELINE_RATCHETS) {
    const drive = ratchetDrives[ratchet.channel];
    if (drive === undefined) {
      failures.push(
        `ratchet drive coverage mismatch: ${ratchet.channel} (${ratchet.path}) has no entry in ratchetDrives, so its comparison in checkArchitecture, its delta channel and its member-shape check are all deletable with every gate green`,
      );
      continue;
    }
    const driveArchitecture = syntheticArchitecture({
      ...drive.plant,
      moduleNodes: liveModuleNodes,
    });
    const reported = checkArchitecture(driveArchitecture, syntheticBaseline());
    if (!reported.some((violation) => violation.includes(drive.reports))) {
      failures.push(
        `ratchet drive mismatch: expected checkArchitecture to report "${drive.reports}" for a ${ratchet.path} member the baseline does not hold, received ${JSON.stringify(reported)}`,
      );
    }
    const driveDocument = baselineDocument(driveArchitecture);
    const emitted = ratchetList(driveDocument, ratchet.path);
    if (!Array.isArray(emitted) || !emitted.includes(drive.member)) {
      failures.push(
        `ratchet drive mismatch: expected the emitted document to carry ${JSON.stringify(drive.member)} at ${ratchet.path}, received ${JSON.stringify(emitted)}`,
      );
    }
    const channelDelta = baselineDelta(
      baselineWithList(ratchet.path, [drive.removedMember]),
      driveDocument,
    )[ratchet.channel];
    if (
      !channelDelta?.added.includes(drive.member) ||
      !channelDelta?.removed.includes(drive.removedMember)
    ) {
      failures.push(
        `ratchet drive mismatch: expected the ${ratchet.channel} delta channel to read ${ratchet.path} on both sides and report ${JSON.stringify(drive.member)} added and ${JSON.stringify(drive.removedMember)} removed, received ${JSON.stringify(channelDelta)}`,
      );
    }
    const memberShapeFaults = baselineRatchetFaults(
      baselineWithList(ratchet.path, [drive.malformedMember]),
    );
    if (!memberShapeFaults.some((fault) => fault === drive.malformedFault)) {
      failures.push(
        `ratchet drive mismatch: expected baselineRatchetFaults to report "${drive.malformedFault}", received ${JSON.stringify(memberShapeFaults)}`,
      );
    }
  }
  for (const channel of Object.keys(ratchetDrives)) {
    if (deltaRatchetKeys.includes(channel)) continue;
    failures.push(
      `ratchet drive coverage mismatch: ratchetDrives names ${channel}, which is not a BASELINE_RATCHETS channel — a drive for a ratchet that no longer exists proves nothing`,
    );
  }

  // (xiii) A recorded graph must declare its own cycles (item 37). This is the only
  // evidence the cross-check does anything: today's committed file declares no cycle in
  // either graph, so nothing observable changes on the live tree. One drive per recorded
  // graph, planted through the row's own two paths, because the two graphs are two
  // iterations of one loop and a table that lost a row would otherwise take a graph's
  // check away silently.
  for (const graph of RECORDED_GRAPHS) {
    // (xiii-a) THE UNION CASE, expressed at the seam: two independently regenerated
    // baselines merge into edges that form a component neither declared. Red before the
    // cross-check existed — the merged file passed every gate and granted the cycle.
    const unionFault = `${graph.path} forms [["union-a","union-b"]], but ${graph.declaredCyclesPath} declares []`;
    const unionFaults = baselineSelfPermissionFaults(
      baselineWithGraph(graph, ["union-a -> union-b", "union-b -> union-a"], []),
    );
    if (!unionFaults.some((fault) => fault === unionFault)) {
      failures.push(
        `baseline self-permission self-test mismatch: expected "${unionFault}" for a ${graph.path} that records both directions of a cycle ${graph.declaredCyclesPath} does not declare, received ${JSON.stringify(unionFaults)}`,
      );
    }
    // (xiii-b) The opposite drift: a declaration the edges do not form. Pins clause (a)
    // as an equality rather than a subset.
    const staleFault = `${graph.path} forms [], but ${graph.declaredCyclesPath} declares [["stale-a","stale-b"]]`;
    const staleFaults = baselineSelfPermissionFaults(
      baselineWithGraph(graph, ["stale-a -> stale-b"], [["stale-a", "stale-b"]]),
    );
    if (!staleFaults.some((fault) => fault === staleFault)) {
      failures.push(
        `baseline self-permission self-test mismatch: expected "${staleFault}" for a ${graph.declaredCyclesPath} declaring a component ${graph.path} does not form, received ${JSON.stringify(staleFaults)}`,
      );
    }
    // (xiii-c) A hand-written self-loop. Pins clause (b) on its own: the SCC pass filters
    // length-1 components out, so clause (a) is green here and only (b) can report it.
    const selfLoopFault = `${graph.path} permits ["loop-a -> loop-a"], which lies in no component ${graph.declaredCyclesPath} declares`;
    const selfLoopFaults = baselineSelfPermissionFaults(
      baselineWithGraph(graph, ["loop-a -> loop-a"], []),
    );
    if (!selfLoopFaults.some((fault) => fault === selfLoopFault)) {
      failures.push(
        `baseline self-permission self-test mismatch: expected "${selfLoopFault}" for a hand-written self-edge, received ${JSON.stringify(selfLoopFaults)}`,
      );
    }
    // (xiii-d) The declared list's own shape, in the boundary that owns it. Without these
    // the comparison one hop down meets a number where a node name belongs.
    for (const [declared, expected] of [
      [
        [["shape-a", 42]],
        `${graph.declaredCyclesPath}[0] is not a list of node names: ["shape-a",42]`,
      ],
      [["shape-a"], `${graph.declaredCyclesPath}[0] is not a list of node names: "shape-a"`],
      [{}, `${graph.declaredCyclesPath} is missing or not an array`],
    ]) {
      const shapeFaults = baselineRatchetFaults(baselineWithGraph(graph, [], declared));
      if (!shapeFaults.some((fault) => fault === expected)) {
        failures.push(
          `baseline declared-cycle shape self-test mismatch: expected "${expected}", received ${JSON.stringify(shapeFaults)}`,
        );
      }
    }
  }
  // (xiii-e) The cross-check is WIRED INTO `loadBaseline`, which is the only reason it is
  // tier 1: every path that reads the baseline goes through that function. The drives
  // above call the predicate directly, so without this one the call site is deletable
  // with every gate green — the failure this campaign has hit repeatedly. `loadBaseline`
  // reads a path, so the drive needs a file: it is written under the system temp
  // directory, never in the repository, and removed again.
  const wiringDirectory = mkdtempSync(join(tmpdir(), "check-module-architecture-"));
  try {
    const wiringPath = join(wiringDirectory, "baseline.json");
    writeFileSync(
      wiringPath,
      JSON.stringify(
        baselineWithGraph(RECORDED_GRAPHS[0], ["union-a -> union-b", "union-b -> union-a"], []),
      ),
    );
    const wiringLoad = loadBaseline(wiringPath);
    if (wiringLoad.ok || !wiringLoad.error?.includes("permits a cycle it does not declare")) {
      failures.push(
        `baseline load self-test mismatch: expected loadBaseline to refuse a baseline whose recorded edges form a component its declared cycles omit, received ${JSON.stringify(wiringLoad)}`,
      );
    }
  } finally {
    rmSync(wiringDirectory, { force: true, recursive: true });
  }

  // There is deliberately NO drive over the COMMITTED baseline here. The self-test runs
  // before every flag, so a drive that reads the real file reports a merge or a hand edit
  // as "parser self-test failed" and takes `--print-graph` and `--write-baseline` down
  // with it — the recovery commands. The committed file is already read on every run by
  // `loadBaseline`, which reports the same fault under its own cause and leaves both
  // flags reachable.

  // (xiv) `loadBaseline`'s two read failures. Both were undriven: deleting the
  // `existsSync` branch left an absent file reporting itself as "not valid JSON: ENOENT"
  // with every gate green, which contradicts the enumeration in
  // `docs/reference/architecture.md`. Neither drive writes anything — the missing case
  // names a path that must not exist, and the unparseable case names this script, a real
  // file that is not JSON.
  const missingBaselineLoad = loadBaseline(
    join(ROOT, "scripts/.baseline-that-does-not-exist.json"), // path-ok: the drive's subject is that this path is absent
  );
  if (missingBaselineLoad.ok || !missingBaselineLoad.error?.startsWith("missing ")) {
    failures.push(
      `baseline load self-test mismatch: expected an absent baseline to report itself as missing, received ${JSON.stringify(missingBaselineLoad)}`,
    );
  }
  const unparsableBaselineLoad = loadBaseline(fileURLToPath(import.meta.url));
  if (unparsableBaselineLoad.ok || !unparsableBaselineLoad.error?.includes("is not valid JSON")) {
    failures.push(
      `baseline load self-test mismatch: expected a non-JSON baseline to report itself as unparseable, received ${JSON.stringify(unparsableBaselineLoad)}`,
    );
  }

  const lifecycleSource = `
export function registerExample(): void {}
export function unregisterExample(): void {}
`;
  const validManifestSource = `
import { registerExample, unregisterExample } from "./example";
export const RUNTIME_ADAPTERS = [
  { register: registerExample, unregister: unregisterExample },
];
`;
  const lifecycleFixture = [
    { file: join(API_COMPOSITION_ROOT, "example.ts"), source: lifecycleSource },
  ];
  const validLifecycleViolations = runtimeAdapterViolations(lifecycleFixture, validManifestSource);
  if (validLifecycleViolations.length > 0) {
    failures.push(
      `runtime adapter fixture mismatch: expected no violations, received ${JSON.stringify(validLifecycleViolations)}`,
    );
  }
  const omittedLifecycleViolations = runtimeAdapterViolations(
    lifecycleFixture,
    validManifestSource.replace(
      "{ register: registerExample, unregister: unregisterExample },",
      "",
    ),
  );
  if (
    !omittedLifecycleViolations.some((violation) =>
      violation.includes("must list registerExample/unregisterExample exactly once"),
    )
  ) {
    failures.push(
      `runtime adapter omission fixture mismatch: received ${JSON.stringify(omittedLifecycleViolations)}`,
    );
  }

  // A boot-seam call with three of four labels must report the fourth as missing.
  const bootSeamFixtureSource = `
/**
 * Surface:  chat.
 * Owns/hides: the fixture seam; keeps its slot private.
 * Why the seam: it proves the header check fails on a missing label.
 */
const examplePort = bootPort<Example>("example");
`;
  const bootSeamFixtureViolations = bootSeamHeaderViolations([
    { file: join(TOOL_RUNTIME_ROOT, "self-test-fixture.ts"), source: bootSeamFixtureSource },
  ]);
  if (!bootSeamFixtureViolations.some((violation) => violation.includes('missing "Wiring:"'))) {
    failures.push(
      `boot-seam header fixture mismatch: received ${JSON.stringify(bootSeamFixtureViolations)}`,
    );
  }

  // Two seams in one file: the first carries a full header, the second none. A per-file
  // includes() check would pass this (every label appears once, for the first seam), so
  // the fixture proves the check counts labels per seam.
  const twoSeamFixtureSource = `
/**
 * Surface:  chat.
 * Owns/hides: the first fixture seam; keeps its slot private.
 * Why the seam: it inverts an import edge for the test.
 * Wiring:   the test installs it; the test reads it.
 */
const firstPort = bootPort<First>("first");

const secondPort = bootPort<Second>("second");
`;
  const twoSeamFixtureViolations = bootSeamHeaderViolations([
    {
      file: join(TOOL_RUNTIME_ROOT, "self-test-two-seam-fixture.ts"),
      source: twoSeamFixtureSource,
    },
  ]);
  if (
    !BOOT_SEAM_HEADER_LABELS.every((label) =>
      twoSeamFixtureViolations.some((violation) => violation.includes(`missing "${label}"`)),
    )
  ) {
    failures.push(
      `boot-seam header two-seam fixture mismatch: received ${JSON.stringify(twoSeamFixtureViolations)}`,
    );
  }

  // Two seams, and each label appears an extra time in prose, so a file-wide count of
  // each label reaches the seam count and passes. The second seam still has no adjacent
  // header, so a position-bound check must report it. This proves the check binds a
  // header to its seam, not to the file.
  const repeatedLabelFixtureSource = `
/**
 * Surface:  chat.
 * Owns/hides: the first fixture seam; keeps its slot private.
 * Why the seam: it inverts an import edge for the test.
 * Wiring:   the test installs it; the test reads it.
 */
const firstPort = bootPort<First>("first");

// Surface: Owns/hides: Why the seam: Wiring: appear again here in prose only.
const secondPort = bootPort<Second>("second");
`;
  const repeatedLabelFixtureViolations = bootSeamHeaderViolations([
    {
      file: join(TOOL_RUNTIME_ROOT, "self-test-repeated-label-fixture.ts"),
      source: repeatedLabelFixtureSource,
    },
  ]);
  if (!repeatedLabelFixtureViolations.some((violation) => violation.includes("for Second"))) {
    failures.push(
      `boot-seam header repeated-label fixture mismatch: received ${JSON.stringify(repeatedLabelFixtureViolations)}`,
    );
  }

  // The evasion four review rounds could not close with a call-site generic trigger:
  // the generic sits on the VARIABLE, so the call is a bare `bootPort(`. Detection keys
  // on bootPort + `<` or `(`, so the bare call is still a seam and its missing header is
  // reported.
  const variableGenericFixtureSource = `
const evasivePort: BootPort<Evasive> = bootPort("evasive");
`;
  const variableGenericFixtureViolations = bootSeamHeaderViolations([
    {
      file: join(TOOL_RUNTIME_ROOT, "self-test-variable-generic-fixture.ts"),
      source: variableGenericFixtureSource,
    },
  ]);
  if (variableGenericFixtureViolations.length === 0) {
    failures.push(
      `boot-seam header variable-generic fixture mismatch: received ${JSON.stringify(variableGenericFixtureViolations)}`,
    );
  }

  // The import-anchor backstop. A file that hides the call behind an alias exposes no
  // `bootPort(` to detect, but it must still import the factory. The import is the
  // evasion-proof trigger, so a headerless aliasing file fails on every label.
  const aliasImportFixtureSource = `
import { bootPort } from "./boot-port";
const make = bootPort;
const aliasedPort = make("aliased");
`;
  const aliasImportFixtureViolations = bootSeamHeaderViolations([
    {
      file: join(TOOL_RUNTIME_ROOT, "self-test-alias-import-fixture.ts"),
      source: aliasImportFixtureSource,
    },
  ]);
  if (
    !BOOT_SEAM_HEADER_LABELS.every((label) =>
      aliasImportFixtureViolations.some((violation) => violation.includes(`missing "${label}"`)),
    )
  ) {
    failures.push(
      `boot-seam header alias-import fixture mismatch: received ${JSON.stringify(aliasImportFixtureViolations)}`,
    );
  }

  // (a) Scanned-path liveness, red case. One absent row must be reported and must name
  // its constant, so the message tells the reader which of the two edits to make. Pure,
  // no filesystem.
  const absentPathViolations = scannedPathLivenessViolations([
    {
      constant: "SELF_TEST_ABSENT_ROOT",
      path: "/self-test/absent",
      kind: "directory",
      present: false,
    },
  ]);
  if (!absentPathViolations.some((violation) => violation.includes("SELF_TEST_ABSENT_ROOT"))) {
    failures.push(
      `scanned-path liveness fixture mismatch: expected an absent row to be reported by constant name, received ${JSON.stringify(absentPathViolations)}`,
    );
  }
  // (b) Scanned-path liveness, green case. Without it, (a) also passes for a closure
  // that fires on every row.
  const presentPathViolations = scannedPathLivenessViolations([
    {
      constant: "SELF_TEST_PRESENT_ROOT",
      path: "/self-test/present",
      kind: "directory",
      present: true,
    },
    {
      constant: "SELF_TEST_PRESENT_FILE",
      path: "/self-test/present.ts",
      kind: "file",
      present: true,
    },
  ]);
  if (presentPathViolations.length > 0) {
    failures.push(
      `scanned-path liveness fixture mismatch: expected no violation for an all-present list, received ${JSON.stringify(presentPathViolations)}`,
    );
  }
  // (c) Discovery, over the REAL tool-runtime tree — the drive whose absence let this
  // rule scan zero files. The five fixtures above all pass over an empty file set,
  // because a fixture drives the matcher and not the walk. This asserts the SUBJECT
  // exists: the filtered walk is non-empty and holds at least one `bootPort` call.
  // Accepted trade: deleting the last real seam turns this red, which is the same
  // ruling as `SCANNED_PATHS` — the fix is then to delete the rule, deliberately.
  // Drives the collector the check reads, not a copy of its filter, and deliberately
  // NOT `collectArchitecture()` — the self-test runs before collection, and a full
  // workspace walk inside it is not the trade.
  const discoveredSeamSources = collectBootSeamSources();
  const discoveredSeamCalls = discoveredSeamSources.reduce(
    (total, { source }) => total + findBootPortCalls(source).length,
    0,
  );
  if (discoveredSeamSources.length === 0 || discoveredSeamCalls === 0) {
    failures.push(
      `boot-seam discovery self-test mismatch: ${relativeToRoot(TOOL_RUNTIME_ROOT)} yielded ${discoveredSeamSources.length} scanned files and ${discoveredSeamCalls} bootPort calls, so the header rule enforces nothing — update TOOL_RUNTIME_ROOT or delete the rule that reads it`,
    );
  }
  // (d) The wiring, and the shape of the guard. An absent row must reach
  // `checkArchitecture`'s violation list, and the guard it drives must be PER BLOCK: the
  // cycle rules must still report on the same tree, or a missing path has turned a
  // fail-closed change into a fail-open one.
  const absentPathWiringDrive = checkArchitecture(
    syntheticArchitecture({
      packageGraph: { edges: ["a -> b", "b -> a"] },
      scannedPaths: [
        {
          constant: "TOOL_RUNTIME_ROOT",
          path: TOOL_RUNTIME_ROOT,
          kind: "directory",
          present: false,
        },
      ],
    }),
    syntheticBaseline(),
  );
  if (!absentPathWiringDrive.some((violation) => violation.includes("update TOOL_RUNTIME_ROOT"))) {
    failures.push(
      `scanned-path liveness wiring self-test mismatch: expected checkArchitecture to report an absent scanned path, received ${JSON.stringify(absentPathWiringDrive)}`,
    );
  }
  if (
    !absentPathWiringDrive.some((violation) =>
      violation.includes("new cyclic package edge: a -> b"),
    )
  ) {
    failures.push(
      `scanned-path guard self-test mismatch: expected the cycle rules to still report while a scanned path is absent, received ${JSON.stringify(absentPathWiringDrive)}`,
    );
  }
  // (e) Collector defensiveness (item 38). The two collectors are the only places a
  // hardcoded path is read, so absence must become a value here, not an exception:
  // before the reads moved, an absent `runtime-adapters.ts` killed this self-test, the
  // plain check AND `--write-baseline` with an uncaught `node:fs` stack. Both paths are
  // parameters so this drive needs no real file moved aside.
  const absentScanRoot = join(ROOT, "scripts/.self-test-absent-scan-root"); // path-ok: the drive's subject is that this scan root is absent
  const absentScan = collectRuntimeAdapterScan(
    absentScanRoot,
    join(absentScanRoot, "runtime-adapters.ts"),
  );
  if (absentScan.compositionSources.length > 0 || absentScan.manifestSource !== null) {
    failures.push(
      `runtime-adapter collector self-test mismatch: expected an absent root to yield no sources and a null manifest, received ${absentScan.compositionSources.length} sources and manifestSource=${typeof absentScan.manifestSource}`,
    );
  }
  const absentSeamSources = collectBootSeamSources(
    absentScanRoot,
    join(absentScanRoot, "boot-port.ts"),
  );
  if (absentSeamSources.length > 0) {
    failures.push(
      `boot-seam collector self-test mismatch: expected an absent root to yield no sources, received ${JSON.stringify(absentSeamSources.map(({ file }) => relativeToRoot(file)))}`,
    );
  }
  // (f) Discovery, over the REAL composition tree — the mirror of (c), and the price of
  // moving these reads into one collector. `SCANNED_PATHS` proves the root RESOLVES and
  // the five fixtures above prove the MATCHER; neither notices a walk that resolves and
  // collects nothing, because a fixture supplies its own source text. Same accepted trade
  // as (c): emptying the directory turns this red, and the fix is then to delete the rule.
  const discoveredCompositionScan = collectRuntimeAdapterScan();
  if (
    discoveredCompositionScan.compositionSources.length === 0 ||
    discoveredCompositionScan.manifestSource === null
  ) {
    failures.push(
      `runtime-adapter discovery self-test mismatch: ${relativeToRoot(API_COMPOSITION_ROOT)} yielded ${discoveredCompositionScan.compositionSources.length} scanned files and manifestSource=${typeof discoveredCompositionScan.manifestSource}, so the runtime-adapter rule enforces nothing — update API_COMPOSITION_ROOT/RUNTIME_ADAPTER_MANIFEST or delete the rule that reads them`,
    );
  }
  // (f-b) Discovery, over the REAL connections barrel — the third mirror of (c), and the one
  // that keeps `connectionsBarrelReachViolations` honest about a subject it cannot see. A walk
  // that visits only the barrel, or none of it, is a rule wearing a green badge: `(0-g)` still
  // passes, because a fixture supplies its own reach. Both halves are asserted, because an
  // emptied `CONNECTIONS_BARREL_FORBIDDEN_REACH` forbids nothing just as completely as a walk
  // that goes nowhere, and neither is visible to any drive above. Same accepted trade as (c)
  // and (f): flattening the connections module turns this red, and the fix is then to delete
  // the rule, deliberately.
  const discoveredBarrelReach = collectConnectionsBarrelReach();
  if (discoveredBarrelReach.reached.length <= 1 || discoveredBarrelReach.forbidden.length === 0) {
    failures.push(
      `connections-barrel discovery self-test mismatch: ${relativeToRoot(CONNECTIONS_BARREL)} yielded ${discoveredBarrelReach.reached.length} reached file(s) against ${discoveredBarrelReach.forbidden.length} forbidden target(s), so the barrel-reach rule enforces nothing — update CONNECTIONS_BARREL/CONNECTIONS_BARREL_FORBIDDEN_REACH or delete the rule that reads them`,
    );
  }
  // (f-c) The WALK itself, over a fixture tree, because every drive above supplies its own
  // reach and none of them runs the breadth-first search. Four things the walk has to get
  // right and no other drive can see:
  //   - transitivity, with the chain naming every hop rather than only the endpoints;
  //   - a leaf import that must NOT drag in its siblings, which is exactly what
  //     `oauth-state -> ingestion/workflow-recovery` relies on;
  //   - a specifier inside a COMMENT, which the real barrel's header contains verbatim as
  //     `export * from "./ingestion"` — a regex walk reports a false reach on a clean tree;
  //   - a bare package specifier and a relative specifier resolving to nothing, neither of
  //     which is a hop.
  // Plants are built off the drive's own `mkdtemp` root, never off the injected argument: the
  // "repoint it at the real constant" mutant would otherwise write fixtures into
  // `packages/assistant/src` while the `finally` cleans only the temp directory.
  const barrelWalkDirectory = mkdtempSync(join(tmpdir(), "check-module-architecture-"));
  try {
    const walkRoot = join(barrelWalkDirectory, "connections");
    const fixtureBarrel = join(walkRoot, "index.ts");
    const fixtureQueue = join(walkRoot, "ingestion", "queue.ts");
    mkdirSync(dirname(fixtureBarrel), { recursive: true });
    writeFileSync(
      fixtureBarrel,
      [
        "/** It deliberately does NOT re-export `./ingestion`:",
        ' *   export * from "./ingestion";',
        " */",
        'export * from "./availability";',
        'export * from "./oauth-state";',
        'export * from "@alfred/contracts";',
        'export * from "./deleted-sibling";',
        "",
      ].join("\n"),
    );
    plant(join(walkRoot, "availability.ts"), "./ingestion/queue.ts");
    plant(join(walkRoot, "oauth-state.ts"), "./ingestion/workflow-recovery.ts");
    plant(join(walkRoot, "ingestion", "workflow-recovery.ts"), null);
    plant(fixtureQueue, null);
    const fixtureWalk = collectConnectionsBarrelReach(fixtureBarrel, [fixtureQueue]);
    const chainFor = (basename) =>
      fixtureWalk.reached.find((entry) => entry.file.endsWith(basename))?.chain ?? null;
    for (const [basename, expectedChain, position] of [
      ["index.ts", "index.ts", "the barrel is the root of its own walk"],
      ["availability.ts", "index.ts -> availability.ts", "a one-hop relative export"],
      [
        "queue.ts",
        "index.ts -> availability.ts -> ingestion/queue.ts",
        "a two-hop transitive reach, which is the whole point of the rule",
      ],
      [
        "workflow-recovery.ts",
        "index.ts -> oauth-state.ts -> ingestion/workflow-recovery.ts",
        "the leaf import that must not drag its siblings in",
      ],
    ]) {
      if (chainFor(basename) !== expectedChain) {
        failures.push(
          `connections-barrel walk self-test mismatch: expected ${basename} to be reached as "${expectedChain}" for ${position}, received ${JSON.stringify(chainFor(basename))}`,
        );
      }
    }
    // The commented specifier resolves to a real fixture directory, so a regex walk WOULD
    // follow it. `ingestion/index.ts` is deliberately never planted: if the walk ever reports
    // reaching it, the lexer stopped consuming comments.
    if (fixtureWalk.reached.some((entry) => entry.chain.includes("ingestion/index.ts"))) {
      failures.push(
        `connections-barrel walk self-test mismatch: the walk followed a specifier that exists only inside a comment, so it is not lexing its input, received ${JSON.stringify(fixtureWalk.reached)}`,
      );
    }
    if (fixtureWalk.reached.length !== 5) {
      failures.push(
        `connections-barrel walk self-test mismatch: expected exactly the 5 planted files to be reached, so that a bare package specifier and a relative specifier resolving to nothing are both non-hops, received ${JSON.stringify(fixtureWalk.reached)}`,
      );
    }
    if (!fixtureWalk.forbidden.every((entry) => entry.present)) {
      failures.push(
        `connections-barrel walk self-test mismatch: expected the planted forbidden target to be collected as present, received ${JSON.stringify(fixtureWalk.forbidden)}`,
      );
    }
  } finally {
    rmSync(barrelWalkDirectory, { force: true, recursive: true });
  }
  // (g) Runtime-adapter wiring. The fixtures above drive `runtimeAdapterViolations`, not
  // its push: deleting that push left every gate green, because the real tree is clean.
  // Reuses the omission fixture's own source text, so this pins the wiring and not the
  // matcher.
  const runtimeAdapterWiringDrive = checkArchitecture(
    syntheticArchitecture({
      runtimeAdapterScan: {
        compositionSources: lifecycleFixture,
        manifestSource: validManifestSource.replace(
          "{ register: registerExample, unregister: unregisterExample },",
          "",
        ),
      },
    }),
    syntheticBaseline(),
  );
  if (
    !runtimeAdapterWiringDrive.some((violation) =>
      violation.includes("must list registerExample/unregisterExample exactly once"),
    )
  ) {
    failures.push(
      `runtime-adapter wiring self-test mismatch: expected checkArchitecture to report the unlisted lifecycle pair, received ${JSON.stringify(runtimeAdapterWiringDrive)}`,
    );
  }
  // (h) Boot-seam wiring, the same shape one rule over. Also deletable-green before this
  // drive existed.
  const bootSeamWiringDrive = checkArchitecture(
    syntheticArchitecture({
      bootSeamSources: [
        { file: join(TOOL_RUNTIME_ROOT, "self-test-fixture.ts"), source: bootSeamFixtureSource },
      ],
    }),
    syntheticBaseline(),
  );
  if (!bootSeamWiringDrive.some((violation) => violation.includes('missing "Wiring:"'))) {
    failures.push(
      `boot-seam wiring self-test mismatch: expected checkArchitecture to report the headerless seam, received ${JSON.stringify(bootSeamWiringDrive)}`,
    );
  }
  return failures;
}

function formatGraph(architecture) {
  return JSON.stringify(
    {
      packages: architecture.packageGraph,
      assistantModules: architecture.moduleGraph,
    },
    null,
    2,
  );
}

/**
 * Absolute forbidden-import gate for the durable-execution module (item 06). For
 * every live `agent -> P` module edge where P is in
 * {@link EXECUTION_FORBIDDEN_PRODUCT_MODULES}, report a violation. Consulted
 * against the *current* module graph (`moduleEdges`), never the baseline, so a
 * grandfathered baseline SCC edge cannot launder a re-introduced product import.
 * Pure over the edge list so the self-test can exercise it on synthetic edges.
 */
function executionForbiddenImportViolations(moduleEdges) {
  const violations = [];
  for (const edge of moduleEdges) {
    if (edge.from === EXECUTION_MODULE && EXECUTION_FORBIDDEN_PRODUCT_MODULES.has(edge.to)) {
      violations.push(`execution imports forbidden product module: ${edge.from} -> ${edge.to}`);
    }
  }
  return violations;
}

/**
 * Liveness gate for the execution forbidden-import rule (item 11). The forbidden
 * gate scans for `EXECUTION_MODULE -> P` edges; if `EXECUTION_MODULE` (or any
 * entry of {@link EXECUTION_FORBIDDEN_PRODUCT_MODULES}) does not name a *live*
 * module node, it silently enforces nothing — a Phase-6 rename (`agent ->
 * execution`) or a typo (`"traige"`) would turn the whole gate into a vacuous
 * pass. This closure fails loudly instead: given the live module-node set, it
 * reports every constant that no longer resolves to a real module directory, so
 * the fix (update the constant) is named in the message. Pure over the node
 * list so the self-test can drive it on a synthetic graph.
 */
function executionGateLivenessViolations(moduleNodes) {
  const liveModules = new Set(moduleNodes);
  const violations = [];
  if (!liveModules.has(EXECUTION_MODULE)) {
    violations.push(
      `execution gate references unknown module "${EXECUTION_MODULE}" — was the module renamed? update EXECUTION_MODULE`,
    );
  }
  for (const forbidden of EXECUTION_FORBIDDEN_PRODUCT_MODULES) {
    if (!liveModules.has(forbidden)) {
      violations.push(
        `execution gate forbidden set references unknown module "${forbidden}" — typo or renamed/removed? update EXECUTION_FORBIDDEN_PRODUCT_MODULES`,
      );
    }
  }
  return violations;
}

/**
 * The connections-barrel forbidden-reach gate (item 52). Absolute, like
 * {@link executionForbiddenImportViolations}: consulted against the walk of the CURRENT tree,
 * never the baseline, so no ratchet regeneration can permit it later.
 *
 * Two things are reported. A forbidden target that is not a file is the analogue of
 * {@link executionGateLivenessViolations}' unknown-module refusal — a renamed `queue.ts` would
 * otherwise turn this half of the rule into a vacuous pass, silently. A reached file that is a
 * forbidden target is the rule itself, reported with the chain that produced it.
 *
 * Deliberately says nothing about any other barrel. Its scope is the one file whose header
 * records the convention.
 *
 * Pure over the collected walk (item 38): it opens no file and stats no path, so a self-test
 * drive over a synthetic reach reports exactly what that reach plants. The "the walk found
 * more than the barrel itself" liveness assertion is NOT here for that reason — an inert
 * synthetic default is an empty walk, so a starvation check here would fire on every drive of
 * every other rule. It lives in `selfTestFailures` instead, over the real tree, beside the
 * other discovery drives.
 *
 * @param {{ reached: { chain: string, file: string }[],
 *           forbidden: { path: string, present: boolean }[] }} reach
 * @returns {string[]}
 */
function connectionsBarrelReachViolations(reach) {
  const violations = [];
  for (const entry of reach.forbidden) {
    if (entry.present) continue;
    violations.push(
      `connections barrel forbidden-reach target is not a file: ${relativeToRoot(entry.path)} — the rule that names it forbids nothing; update CONNECTIONS_BARREL_FORBIDDEN_REACH or delete the rule that reads it`,
    );
  }
  const forbiddenPaths = new Set(reach.forbidden.map((entry) => entry.path));
  for (const entry of reach.reached) {
    if (!forbiddenPaths.has(entry.file)) continue;
    violations.push(`connections barrel reaches forbidden ingestion module: ${entry.chain}`);
  }
  return violations;
}

/**
 * Liveness gate for every hardcoded repository path a rule in this file reads (item
 * 36). Same shape and same reason as {@link executionGateLivenessViolations}: a rule
 * whose sole input stops resolving enforces nothing. `TOOL_RUNTIME_ROOT` proved it —
 * the boot-seam header rule walked a directory that had not existed since
 * `tool-runtime` moved to `@alfred/assistant`, so it ran over zero files while five
 * matcher fixtures stayed green, because a fixture drives the matcher and not the
 * discovery. Pure over the collected presence list so the self-test can drive it both
 * ways on a synthetic list; the message names the constant, the path and the two
 * legitimate fixes.
 */
function scannedPathLivenessViolations(entries) {
  const violations = [];
  for (const entry of entries) {
    if (entry.present) continue;
    violations.push(
      `scanned ${entry.kind} does not exist: ${entry.path} — the rule that reads it enforces nothing; update ${entry.constant} or delete the rule that reads it`,
    );
  }
  return violations;
}

/**
 * Resolves {@link SCANNED_PATHS} against the working tree. `kind` is load-bearing: a
 * file where a rule walks a directory (or the reverse) leaves the rule as empty as an
 * absent path would, so the type is checked, not just existence.
 */
function scannedPathPresence() {
  return SCANNED_PATHS.map((entry) => {
    let present = false;
    if (existsSync(entry.path)) {
      const stats = statSync(entry.path);
      present = entry.kind === "directory" ? stats.isDirectory() : stats.isFile();
    }
    return { ...entry, present };
  });
}

/**
 * Decides over the two values it is given, and over nothing else: it opens no file and
 * stats no path (item 38). `collectArchitecture` owns every tree read, including the
 * scanned-path presence list, the composition scan and the boot-seam sources, so a
 * self-test drive over a synthetic architecture reports exactly the violations that
 * architecture plants — which is what lets a drive assert an absence.
 */
function checkArchitecture(architecture, baseline) {
  const violations = [];
  // The graph is only as trustworthy as the list of workspaces it was walked over.
  // A refusal here means the walk read fewer trees than the repository has, which
  // makes every absence below meaningless — so it is a violation, not a warning,
  // and it also stops `--write-baseline` recording a graph derived from a partial
  // enumeration as the permitted one.
  for (const failure of architecture.workspaceFailures) {
    violations.push(`workspace enumeration: ${failure}`);
  }
  // The baseline records the whole graph but is consulted ONLY as a cycle
  // allowlist, so it goes through the same SCC pass the live graph does — see
  // `cyclicEdgeKeysOf`. A recorded acyclic edge permits nothing.
  const permittedCyclicPackageEdges = new Set(cyclicEdgeKeysOf(baseline.packageGraph.edges));
  const permittedCyclicModuleEdges = new Set(cyclicEdgeKeysOf(baseline.assistantModuleGraph.edges));
  const currentModuleEdges = edgesFromKeys(architecture.moduleGraph.edges);
  violations.push(...executionForbiddenImportViolations(currentModuleEdges));
  violations.push(...executionGateLivenessViolations(architecture.moduleNodes));
  violations.push(...connectionsBarrelReachViolations(architecture.connectionsBarrelReach));
  const packageCycles = cyclicEdgeKeysOf(architecture.packageGraph.edges);
  const moduleCycles = cyclicEdgeKeysOf(architecture.moduleGraph.edges);

  for (const edge of packageCycles) {
    if (!permittedCyclicPackageEdges.has(edge)) violations.push(`new cyclic package edge: ${edge}`);
  }
  for (const edge of moduleCycles) {
    if (!permittedCyclicModuleEdges.has(edge)) {
      violations.push(`new cyclic assistant-module edge: ${edge}`);
    }
  }

  const allowedPrivateImports = new Set(baseline.legacyExceptions.privateModuleImports.imports);
  for (const imported of architecture.exceptions.privateModuleImports) {
    if (!allowedPrivateImports.has(imported.key)) {
      violations.push(
        `private assistant-module import: ${imported.key} (${imported.from} -> ${imported.to}, line ${imported.line})`,
      );
    }
  }

  const allowedWebImports = new Set(baseline.legacyExceptions.webFeatureImports.imports);
  for (const imported of architecture.exceptions.webFeatureImports) {
    if (!allowedWebImports.has(imported.key)) {
      violations.push(
        `cross-feature web import: ${imported.key} (${imported.from} -> ${imported.to}, line ${imported.line})`,
      );
    }
  }
  for (const imported of architecture.forbiddenBackendImports) {
    violations.push(
      `assistant imports transport or app code: ${imported.key} (line ${imported.line})`,
    );
  }
  for (const imported of architecture.productionPreviewImports) {
    violations.push(
      `production imports preview/debug code: ${imported.key} (line ${imported.line})`,
    );
  }
  // The two rules below run over collected tree reads, so their inputs can be absent.
  // Every absent hardcoded path is reported first, and each rule is then guarded on the
  // SHAPE of its own collected data — never on one early return: a missing tool-runtime
  // root must not also suppress the cycle, private-import and web-feature rules above,
  // which is a fail-open regression in the middle of a fail-closed change. A data-shaped
  // guard also cannot be paired with the wrong row, which a `SCANNED_PATHS` lookup here
  // could be, invisibly, on a clean tree.
  violations.push(...scannedPathLivenessViolations(architecture.scannedPaths));
  if (architecture.runtimeAdapterScan.manifestSource !== null) {
    violations.push(
      ...runtimeAdapterViolations(
        architecture.runtimeAdapterScan.compositionSources,
        architecture.runtimeAdapterScan.manifestSource,
      ),
    );
  }
  violations.push(...bootSeamHeaderViolations(architecture.bootSeamSources));
  return violations.sort((a, b) => a.localeCompare(b));
}

const selfTestErrors = selfTestFailures();
if (selfTestErrors.length > 0) {
  console.error("check-module-architecture: parser self-test failed");
  for (const failure of selfTestErrors) console.error(`- ${failure}`);
  process.exit(1);
}

/**
 * The cause-and-recovery sentence for an unreadable baseline.
 *
 * A baseline that will not load is nearly always a shell redirect: `> <baseline>`
 * truncates the target before this process starts, so the flag reads 0 bytes and writes
 * nothing. The hint therefore belongs on every LIVE path that can observe the damage —
 * putting it only on the removed flag's tombstone leaves it on a branch nobody types.
 */
function baselineRedirectHint() {
  const path = relativeToRoot(BASELINE_PATH);
  return `${BASELINE_FLAG} rewrites ${path} itself: never redirect its output into that file, because the shell truncates the target before this process starts. If ${path} is already damaged, restore it with \`git checkout ${path}\`.`;
}

function reportBaselineLoadFailure(error) {
  console.error(`check-module-architecture: ${error}`);
  console.error(baselineRedirectHint());
}

if (process.argv.includes(REMOVED_BASELINE_FLAG)) {
  console.error(`check-module-architecture: ${REMOVED_BASELINE_FLAG} is now ${BASELINE_FLAG}.`);
  console.error(baselineRedirectHint());
  process.exit(1);
}

const architecture = collectArchitecture();
if (process.argv.includes(BASELINE_FLAG)) {
  // Regeneration may never widen a ratchet: rewrite the file only from a tree this
  // check already accepts. The command owns the write, so no shell redirect can
  // truncate the ratchet it is reading; the delta goes to stderr and nothing goes to
  // stdout.
  const loaded = loadBaseline();
  if (!loaded.ok) {
    reportBaselineLoadFailure(loaded.error);
    process.exit(1);
  }
  const emission = baselineEmission(architecture, loaded.baseline);
  if (!emission.ok) {
    console.error("check-module-architecture: refusing to regenerate the baseline");
    for (const violation of emission.violations) console.error(`- ${violation}`);
    console.error(
      `\nThe tree does not pass check:architecture; regenerating would write these violations into the baseline as permissions. Fix the tree, or hand-edit ${relativeToRoot(BASELINE_PATH)}. A hand edit is legitimate in exactly two cases: an accepted ADR changes the target structure, or a path rename preserves an existing exception. Only the first needs an ADR.`,
    );
    process.exit(1);
  }
  for (const [name, change] of Object.entries(emission.delta)) {
    for (const entry of change.removed) console.error(`- ${name}: ${entry}`);
    for (const entry of change.added) console.error(`+ ${name}: ${entry}`);
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(emission.document, null, 2)}\n`);
  console.error(`check-module-architecture: wrote ${relativeToRoot(BASELINE_PATH)}`);
  process.exit(0);
}
if (process.argv.includes(GRAPH_FLAG)) {
  console.log(formatGraph(architecture));
  process.exit(0);
}

const loadedBaseline = loadBaseline();
if (!loadedBaseline.ok) {
  reportBaselineLoadFailure(loadedBaseline.error);
  process.exit(1);
}
const violations = checkArchitecture(architecture, loadedBaseline.baseline);
if (violations.length > 0) {
  console.error("check-module-architecture: violations found");
  for (const violation of violations) console.error(`- ${violation}`);
  console.error("\nCurrent stable graph:");
  console.error(formatGraph(architecture));
  process.exit(1);
}

console.log(
  `check-module-architecture: clean (${architecture.packageGraph.edges.length} package edges, ${architecture.moduleGraph.edges.length} assistant-module edges, parser self-test passed)`,
);
