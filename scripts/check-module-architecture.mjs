import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_PATH = join(ROOT, "scripts/module-architecture-baseline.json");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const LEGACY_API_MODULES_ROOT = join(ROOT, "packages/api/src/modules");
const ASSISTANT_SOURCE_ROOT = join(ROOT, "packages/assistant/src");
const TARGET_ASSISTANT_MODULES = new Set([
  "artifacts",
  "automation",
  "briefings",
  "capabilities",
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
