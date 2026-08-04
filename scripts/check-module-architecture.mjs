import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_PATH = join(ROOT, "scripts/module-architecture-baseline.json");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const LEGACY_API_MODULES_ROOT = join(ROOT, "packages/api/src/modules");
const ASSISTANT_SOURCE_ROOT = join(ROOT, "packages/assistant/src");
const API_COMPOSITION_ROOT = join(ROOT, "packages/api/src/composition");
const RUNTIME_ADAPTER_MANIFEST = join(API_COMPOSITION_ROOT, "runtime-adapters.ts");
const TOOL_RUNTIME_ROOT = join(LEGACY_API_MODULES_ROOT, "tool-runtime");
const BOOT_PORT_DEFINER = join(TOOL_RUNTIME_ROOT, "boot-port.ts");
// Locates the start of a bootPort<...>( call. It stops at the opening `<`; a
// brace-balanced scan then finds the matching `>`, so a nested or multi-line
// generic (bootPort<ReadonlyMap<K, V>>() ) is still a call, not a dropped file.
const BOOT_PORT_TRIGGER = /\bbootPort\s*</g;
const BOOT_SEAM_HEADER_LABELS = ["Surface:", "Owns/hides:", "Why the seam:", "Wiring:"];
const TARGET_ASSISTANT_MODULES = new Set([
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
  "settings",
  "skills",
  "tasks",
  "time",
  "triage",
]);
const WEB_ROUTES_ROOT = join(ROOT, "apps/web/src/routes");
const GRAPH_FLAG = "--print-graph";
const BASELINE_FLAG = "--print-baseline";

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

function parseImports(source) {
  const tokens = lexSource(source);
  const imports = [];
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }

  function lineAt(position) {
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function add(token, kind) {
    imports.push({
      kind,
      line: lineAt(token.start),
      specifier: token.value,
    });
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "identifier") continue;
    const next = tokens[index + 1];
    const argument = tokens[index + 2];
    if (
      (token.value === "import" || token.value === "require") &&
      next?.value === "(" &&
      argument?.kind === "string"
    ) {
      add(argument, token.value === "import" ? "dynamic-import" : "require");
      continue;
    }
    if (token.value === "import") {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if (candidate.value === ";") break;
        if (candidate.kind === "string") {
          add(candidate, "import");
          break;
        }
      }
      continue;
    }
    if (token.value === "export") {
      let sawFrom = false;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if (candidate.value === ";") break;
        if (candidate.value === "from") sawFrom = true;
        else if (sawFrom && candidate.kind === "string") {
          add(candidate, "export");
          break;
        }
      }
    }
  }
  return [
    ...new Map(imports.map((entry) => [`${entry.line}:${entry.specifier}`, entry])).values(),
  ].sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

function lexSource(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index;
      const quote = char;
      index += 1;
      let value = "";
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: "string", start, value });
      continue;
    }
    if (char === "`") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === "`") {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ kind: "identifier", start, value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", start: index, value: char });
    index += 1;
  }
  return tokens;
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

// Scans the generic that starts at `open` (a `<`) and returns the index just after
// its matching `>`, or -1 when it cannot resolve. It balances `<`/`>` while skipping
// string, template, and comment spans, and it ignores the `>` of an arrow `=>`, so a
// function-typed or comment-bearing generic does not close the depth early.
function scanGenericEnd(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const pair = source.slice(i, i + 2);
    if (pair === "//") {
      const newline = source.indexOf("\n", i);
      if (newline === -1) return -1;
      i = newline;
      continue;
    }
    if (pair === "/*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      i = skipStringSpan(source, i);
      if (i === -1) return -1;
      continue;
    }
    if (pair === "=>") {
      i += 1;
      continue;
    }
    if (char === "<") depth += 1;
    else if (char === ">") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Returns the index of the closing quote of a string or template span that opens at
// `start`, or -1 when it never closes. Honors backslash escapes; ignores template
// interpolation, which cannot appear inside a type argument.
function skipStringSpan(source, start) {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === quote) return i;
  }
  return -1;
}

// Finds every `bootPort<...>(` call in a source. It brace-balances the generic so a
// nested, multi-line, or function-typed argument still reads as one call, and it
// records the seam type name (the first identifier in the generic) and the call's
// line. A `bootPort<` trigger that it cannot resolve to a `bootPort<...>(` call is
// returned as `unresolved` — the caller fails the check on it, never drops it
// silently, so a seam a heuristic cannot parse can never pass headerless.
function findBootPortCalls(source) {
  const calls = [];
  const unresolved = [];
  BOOT_PORT_TRIGGER.lastIndex = 0;
  let match;
  while ((match = BOOT_PORT_TRIGGER.exec(source)) !== null) {
    const open = source.indexOf("<", match.index);
    const lineIndex = source.slice(0, match.index).split("\n").length - 1;
    if (open === -1) {
      unresolved.push(lineIndex);
      continue;
    }
    const genericEnd = scanGenericEnd(source, open);
    if (genericEnd === -1) {
      unresolved.push(lineIndex);
      continue;
    }
    let after = genericEnd;
    while (after < source.length && /\s/.test(source[after])) after++;
    if (source[after] !== "(") {
      unresolved.push(lineIndex);
      continue;
    }
    const nameMatch = source
      .slice(open + 1, genericEnd - 1)
      .match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
    const seamTypeName = nameMatch ? nameMatch[1] : null;
    calls.push({ seamTypeName, lineIndex });
  }
  return { calls, unresolved };
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
    const { calls, unresolved } = findBootPortCalls(source);
    // Fail loud: a `bootPort<` trigger the scanner cannot resolve to a call is never
    // dropped. An unparseable seam fails the check instead of passing headerless.
    for (const lineIndex of unresolved) {
      violations.push(`unparseable bootPort seam in ${relativeToRoot(file)}:${lineIndex + 1}`);
    }
    if (calls.length === 0) continue;
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

function workspaceEntries() {
  const entries = [];
  for (const group of ["apps", "packages"]) {
    for (const directory of listDirectories(join(ROOT, group))) {
      const manifestPath = join(directory, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name !== "string") continue;
      entries.push({
        directory,
        name: manifest.name,
        source: join(directory, "src"),
      });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
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

function moduleForPath(path) {
  if (path.startsWith(`${LEGACY_API_MODULES_ROOT}${sep}`)) {
    const [name] = relative(LEGACY_API_MODULES_ROOT, path).split(sep);
    return name ? { index: join(LEGACY_API_MODULES_ROOT, name, "index.ts"), name } : null;
  }
  if (path.startsWith(`${ASSISTANT_SOURCE_ROOT}${sep}`)) {
    const [name] = relative(ASSISTANT_SOURCE_ROOT, path).split(sep);
    return name && TARGET_ASSISTANT_MODULES.has(name)
      ? { index: join(ASSISTANT_SOURCE_ROOT, name, "index.ts"), name }
      : null;
  }
  return null;
}

function webFeatureForPath(path) {
  if (!path.startsWith(`${WEB_ROUTES_ROOT}${sep}`)) return null;
  const [first] = relative(WEB_ROUTES_ROOT, path).split(sep);
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

function collectArchitecture() {
  const entries = workspaceEntries();
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

        const fromModule = moduleForPath(file);
        let toModule = targetFile ? moduleForPath(targetFile) : null;
        if (!toModule && imported.specifier.startsWith("@alfred/api/modules/")) {
          const name = imported.specifier.split("/")[3];
          if (name) {
            toModule = {
              index: join(LEGACY_API_MODULES_ROOT, name, "index.ts"),
              name,
            };
          }
        } else if (!toModule && imported.specifier.startsWith("@alfred/assistant/")) {
          const name = imported.specifier.split("/")[2];
          if (name && TARGET_ASSISTANT_MODULES.has(name)) {
            toModule = {
              index: join(ASSISTANT_SOURCE_ROOT, name, "index.ts"),
              name,
            };
          }
        }
        if (fromModule && toModule && fromModule.name !== toModule.name) {
          moduleEdges.push({ from: fromModule.name, to: toModule.name });
          if (targetFile !== toModule.index) {
            privateModuleImports.push({
              from: fromModule.name,
              key: importKey(file, imported.specifier),
              line: imported.line,
              to: toModule.name,
            });
          }
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
          const fromFeature = webFeatureForPath(file);
          const toFeature = webFeatureForPath(targetFile);
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
            /^(debug|preview)\./.test(relative(WEB_ROUTES_ROOT, file));
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

  const moduleNodes = [
    ...listDirectories(LEGACY_API_MODULES_ROOT).map((path) => path.split(sep).at(-1)),
    ...listDirectories(ASSISTANT_SOURCE_ROOT)
      .map((path) => path.split(sep).at(-1))
      .filter((name) => name && TARGET_ASSISTANT_MODULES.has(name)),
  ];
  return {
    exceptions: {
      privateModuleImports: privateModuleImports.sort((a, b) => a.key.localeCompare(b.key)),
      webFeatureImports: webFeatureImports.sort((a, b) => a.key.localeCompare(b.key)),
    },
    forbiddenBackendImports,
    moduleGraph: graphFromEdges(moduleNodes, moduleEdges),
    packageGraph: graphFromEdges(
      entries.map((entry) => entry.name),
      packageEdges,
    ),
    productionPreviewImports,
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
  // The fixture uses the real `bootPort<X>(` form, so a literal `bootPort(` matcher
  // would match nothing and this self-test would fail — a green check gates nothing.
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

  // A headerless seam whose generic nests another generic must still be seen. A trigger
  // that stopped at the first `>` would match zero calls, drop the file, and pass a
  // seam with no header. The brace-balanced scanner reads the whole generic.
  const nestedGenericFixtureSource = `
const nestedPort = bootPort<ReadonlyMap<Key, Value>>("nested");
`;
  const nestedGenericFixtureViolations = bootSeamHeaderViolations([
    {
      file: join(TOOL_RUNTIME_ROOT, "self-test-nested-generic-fixture.ts"),
      source: nestedGenericFixtureSource,
    },
  ]);
  if (nestedGenericFixtureViolations.length === 0) {
    failures.push(
      `boot-seam header nested-generic fixture mismatch: received ${JSON.stringify(nestedGenericFixtureViolations)}`,
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

  // A seam whose generic is an arrow type holds a `>` inside `=>`. A raw `<`/`>` count
  // would close the depth at the arrow, miss the call's `(`, and drop the seam. The
  // scanner ignores the arrow's `>`, resolves the call, and reports the missing header.
  const arrowGenericFixtureSource = `
const arrowPort = bootPort<() => void>("arrow");
`;
  const arrowGenericFixtureViolations = bootSeamHeaderViolations([
    {
      file: join(TOOL_RUNTIME_ROOT, "self-test-arrow-generic-fixture.ts"),
      source: arrowGenericFixtureSource,
    },
  ]);
  if (arrowGenericFixtureViolations.length === 0) {
    failures.push(
      `boot-seam header arrow-generic fixture mismatch: received ${JSON.stringify(arrowGenericFixtureViolations)}`,
    );
  }

  // A seam whose generic holds a comment-borne `>` must still be seen. A raw `<`/`>`
  // count would close the depth at the comment's `>`, miss the call's `(`, and drop the
  // seam. The scanner skips the comment span, resolves the call, and reports the miss.
  const commentGenericFixtureSource = `
const commentPort = bootPort<Foo /* > */>("comment");
`;
  const commentGenericFixtureViolations = bootSeamHeaderViolations([
    {
      file: join(TOOL_RUNTIME_ROOT, "self-test-comment-generic-fixture.ts"),
      source: commentGenericFixtureSource,
    },
  ]);
  if (commentGenericFixtureViolations.length === 0) {
    failures.push(
      `boot-seam header comment-generic fixture mismatch: received ${JSON.stringify(commentGenericFixtureViolations)}`,
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

function checkArchitecture(architecture, baseline) {
  const violations = [];
  const baselinePackageEdges = new Set(baseline.packageGraph.edges);
  const baselineModuleEdges = new Set(baseline.assistantModuleGraph.edges);
  const currentPackageEdges = architecture.packageGraph.edges.map((key) => {
    const [from, to] = key.split(" -> ");
    return { from, to };
  });
  const currentModuleEdges = architecture.moduleGraph.edges.map((key) => {
    const [from, to] = key.split(" -> ");
    return { from, to };
  });
  const packageCycles = cyclicEdgeKeys(
    currentPackageEdges,
    stronglyConnectedComponents(
      uniqueSorted(currentPackageEdges.flatMap((edge) => [edge.from, edge.to])),
      currentPackageEdges,
    ),
  );
  const moduleCycles = cyclicEdgeKeys(
    currentModuleEdges,
    stronglyConnectedComponents(
      uniqueSorted(currentModuleEdges.flatMap((edge) => [edge.from, edge.to])),
      currentModuleEdges,
    ),
  );

  for (const edge of packageCycles) {
    if (!baselinePackageEdges.has(edge)) violations.push(`new cyclic package edge: ${edge}`);
  }
  for (const edge of moduleCycles) {
    if (!baselineModuleEdges.has(edge)) {
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
  const compositionSources = walkSourceFiles(API_COMPOSITION_ROOT)
    .filter((file) => file !== RUNTIME_ADAPTER_MANIFEST)
    .map((file) => ({ file, source: readFileSync(file, "utf8") }));
  violations.push(
    ...runtimeAdapterViolations(compositionSources, readFileSync(RUNTIME_ADAPTER_MANIFEST, "utf8")),
  );
  const toolRuntimeSources = walkSourceFiles(TOOL_RUNTIME_ROOT)
    .filter((file) => !/\.test\.tsx?$/.test(file) && file !== BOOT_PORT_DEFINER)
    .map((file) => ({ file, source: readFileSync(file, "utf8") }));
  violations.push(...bootSeamHeaderViolations(toolRuntimeSources));
  return violations.sort((a, b) => a.localeCompare(b));
}

const selfTestErrors = selfTestFailures();
if (selfTestErrors.length > 0) {
  console.error("check-module-architecture: parser self-test failed");
  for (const failure of selfTestErrors) console.error(`- ${failure}`);
  process.exit(1);
}

const architecture = collectArchitecture();
if (process.argv.includes(BASELINE_FLAG)) {
  console.log(JSON.stringify(baselineDocument(architecture), null, 2));
  process.exit(0);
}
if (process.argv.includes(GRAPH_FLAG)) {
  console.log(formatGraph(architecture));
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`check-module-architecture: missing ${relativeToRoot(BASELINE_PATH)}`);
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const violations = checkArchitecture(architecture, baseline);
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
