import { RuleTester } from "oxlint/plugins-dev";

import { sha256OverJsonStringifyRule } from "./sha256-over-json-stringify.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const error = { messageId: "jsonPreimage" };

const helperError = (helper: string) => ({ messageId: "jsonIntoHashHelper", data: { helper } });

// The cases up to "Holes closed by the AST port" are the fixtures this rule had in
// scripts/consolidation-rules.selftest.mjs, moved with the same code and outcome. A
// fixture that was a statement fragment is wrapped in a function body, so `return` and
// `await` parse.
const inFunction = (body: string) => `async function fixture() {\n${body}\n}`;

tester.run("alfred/sha256-over-json-stringify", sha256OverJsonStringifyRule, {
  valid: [
    {
      name: "a Web Crypto digest over encoded raw text",
      code: inFunction(`  const bytes = new TextEncoder().encode(rawBody);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const inline = await crypto.subtle.digest("SHA-256", encoder.encode(rawBody));`),
    },
    {
      // `attachment-ingest.ts` encodes JSON to write it, not to hash it.
      name: "a Web Crypto digest over other bytes beside encoded JSON",
      code: inFunction(`  const artifact = new TextEncoder().encode(JSON.stringify(meta));
  await writeObject(key, artifact, "application/json");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const fileDigest = await crypto.subtle.digest("SHA-256", fileBytes);`),
    },
    {
      name: "a second function rebinds the encoded name to raw bytes",
      code: `async function writeMeta(key: string, meta: Meta) {
  const bytes = new TextEncoder().encode(JSON.stringify(meta));
  await writeObject(key, bytes, "application/json");
}

async function fileDigest(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return crypto.subtle.digest("SHA-256", bytes);
}`,
    },
    {
      name: "a second function rebinds the hasher name to another object",
      code: `function rawHash(rawBody: string) {
  const entry = createHash("sha256");
  entry.update(rawBody);
  return entry.digest("hex");
}

function touch(key: string, value: Doc) {
  const entry = cache.get(key);
  entry.update(JSON.stringify(value));
}`,
    },
    {
      name: "a digest over Buffer.from of raw text",
      code: inFunction(`  const bytes = Buffer.from(rawText);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const inline = await crypto.subtle.digest("SHA-256", Buffer.from(rawText, "utf8"));
  const hash = createHash("sha256").update(Buffer.from(rawText)).digest("hex");`),
    },
    {
      name: "a second function takes the encoded name as a parameter",
      code: `async function writeMeta(key: string, meta: Meta) {
  const bytes = new TextEncoder().encode(JSON.stringify(meta));
  await writeObject(key, bytes, "application/json");
}

async function fileDigest(bytes: Uint8Array) {
  return crypto.subtle.digest("SHA-256", bytes);
}`,
    },
    {
      name: "a second function takes the hasher name as a parameter",
      code: `function rawHash(rawBody: string) {
  const hash = createHash("sha256");
  hash.update(rawBody);
  return hash.digest("hex");
}

function touch(hash: CacheEntry, value: Doc) {
  hash.update(JSON.stringify(value));
}`,
    },
    {
      name: "an arrow takes the JSON name as a parameter",
      code: inFunction(`  const body = JSON.stringify(payload);
  await fetch(url, { method: "POST", body });
  const hashBody = (body: string): string => createHash("sha256").update(body).digest("hex");`),
    },
    {
      name: "the encoded name reassigned to raw bytes before the digest",
      code: inFunction(`  let bytes = encoder.encode(JSON.stringify(meta));
  await writeObject(key, bytes, "application/json");
  bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);`),
    },
    {
      // The name is bound to raw bytes. The JSON is bound to another name, or only compared.
      name: "a bound name that is not JSON fed to a hasher",
      code: inFunction(`  const buf = Buffer.from(rawBody);
  const summary = JSON.stringify(meta);
  const hash = createHash("sha256");
  hash.update(buf);
  if (body === JSON.stringify(previous)) return;
  const bodyHash = createHash("sha256").update(body).digest("hex");`),
    },
    {
      name: "JSON after the hashed call returns",
      code: inFunction(
        `  const label = createHash("sha256").update(format(id, rawBody)).digest("hex") + JSON.stringify(meta);`,
      ),
    },
    {
      // The JSON sits outside the argument that is encoded or hashed.
      name: "JSON.stringify outside the hashed argument",
      code: inFunction(`  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(rawText));
  const hash = createHash("sha256").update(rawBody).digest("hex");
  log(encoder.encode(rawText), JSON.stringify(meta));
  const label = hash + JSON.stringify(meta);`),
    },
    {
      name: "hashing raw bytes is a different operation",
      code: inFunction(`  return createHash("sha256").update(rawBody).digest("hex");`),
    },
    {
      name: "a bound hasher fed raw bytes is a different operation",
      code: inFunction(`  const hash = createHash("sha256");
  hash.update(rawBody);
  const summary = JSON.stringify(meta);`),
    },
    {
      name: "another algorithm over raw bytes is a different operation",
      code: inFunction(`  return createHash("sha1").update(rawBody).digest("hex");`),
    },
    {
      // A MAC is checked over the bytes that came with it, and sha256Canonical takes no
      // key, so the fix text does not apply.
      name: "an HMAC is a signature, not a content hash",
      code: inFunction(
        `  const sig = createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");`,
      ),
    },
    {
      name: "sha256Canonical is the intended form",
      code: inFunction(`  const evidenceHash = sha256Canonical(value);`),
    },

    // Holes closed by the AST port (#1378 "Holes that remain").
    {
      name: "hole 1 — a class method takes the encoded name as a parameter",
      code: `const bytes = new TextEncoder().encode(JSON.stringify(meta));
await writeObject(key, bytes, "application/json");

class FileStore {
  digest(bytes: Uint8Array) {
    return crypto.subtle.digest("SHA-256", bytes);
  }
}`,
    },
    {
      name: "hole 1 — an object method takes the JSON name as a parameter",
      code: `const body = JSON.stringify(payload);
await fetch(url, { method: "POST", body });

const hashing = {
  of(body: string) {
    return createHash("sha256").update(body).digest("hex");
  },
};`,
    },
    {
      name: "hole 2 — a destructured binding of the encoded name",
      code: `async function writeMeta(key: string, meta: Meta) {
  const bytes = new TextEncoder().encode(JSON.stringify(meta));
  await writeObject(key, bytes, "application/json");
}

async function fileDigest(file: StoredFile) {
  const { bytes } = file;
  return crypto.subtle.digest("SHA-256", bytes);
}`,
    },
    {
      name: "hole 2 — a catch binding of the JSON name",
      code: inFunction(`  const body = JSON.stringify(payload);
  try {
    await send(body);
  } catch (body) {
    return createHash("sha256").update(body).digest("hex");
  }`),
    },
    {
      name: "hole 5 — a same-file helper called with raw text",
      code: `function hashOf(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

const key = hashOf(rawBody);
const summary = JSON.stringify(meta);`,
    },
    {
      // An import from a module that is not a hash owner is not a sink. That module
      // cannot export a hasher: alfred/no-exported-hasher reports one there.
      name: "hole 5 — an import from a module that is not a hash owner",
      filename: "packages/assistant/src/knowledge/digest.ts",
      code: `import { hashOf } from "./hash";
import { sha256Hex } from "@alfred/db";

const key = hashOf(JSON.stringify(payload));
const other = sha256Hex(JSON.stringify(payload));`,
    },

    // Owner hashers in another file (scripts/oxlint/alfred/shared/hash-owners.ts).
    {
      // The owner module defines the helper. Its body digests a parameter, and no call
      // in the file passes JSON.
      name: "the owner module defines its hashers",
      filename: "packages/db/src/hash.ts",
      code: `import { canonicalJson } from "@alfred/contracts";
import { createHash } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256Canonical(value: unknown): string {
  return \`sha256:\${sha256Hex(canonicalJson(value))}\`;
}`,
    },
    {
      name: "an owner hasher over raw text or a structured value",
      code: `import { sha256Canonical, sha256Hex } from "@alfred/db/hash";

const key = sha256Hex(rawBody);
const evidence = sha256Canonical({ kind, payload });
const summary = JSON.stringify(meta);`,
    },
    {
      // The scope manager resolves the callee, so a parameter that shadows the import
      // is not the owner hasher.
      name: "a parameter that shadows an owner hasher import",
      code: `import { sha256Hex } from "@alfred/db/hash";

function run(sha256Hex: (text: string) => string) {
  return sha256Hex(JSON.stringify(payload));
}`,
    },
  ],
  invalid: [
    {
      // The evidence hashes sha256Canonical replaced (dea6a7bd).
      name: "the one-line evidence hash",
      code: inFunction(
        `  return createHash("sha256").update(JSON.stringify(value)).digest("hex");`,
      ),
      errors: [error],
    },
    {
      name: "the chain the formatter split across lines",
      code: inFunction(`  return createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");`),
      errors: [error],
    },
    {
      name: "the hasher bound first, then fed JSON",
      code: inFunction(`  const hash = createHash("sha256");
  hash.update(JSON.stringify(payload));
  return hash.digest("hex");`),
      errors: [error],
    },
    {
      // The bug is the key-order pre-image, not the algorithm.
      name: "another algorithm over JSON is the same bug",
      code: inFunction(`  return createHash("md5").update(JSON.stringify(value)).digest("hex");`),
      errors: [error],
    },
    {
      name: "a hasher bound with another algorithm, then fed JSON",
      code: inFunction(`  const hash = createHash(algorithm);
  hash.update(JSON.stringify(payload));
  return hash.digest("hex");`),
      errors: [error],
    },
    {
      // The Web Crypto digest has the same key-order pre-image.
      name: "a Web Crypto digest over encoded JSON",
      code: inFunction(`  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );`),
      errors: [error],
    },
    {
      name: "a Web Crypto digest through a bound encoder",
      code: inFunction(`  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value)));`),
      errors: [error],
    },
    {
      name: "encoded JSON bound first, then digested",
      code: inFunction(`  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);`),
      errors: [error],
    },
    {
      name: "a Web Crypto digest over Buffer.from of JSON",
      code: inFunction(
        `  const digest = await crypto.subtle.digest("SHA-256", Buffer.from(JSON.stringify(value)));`,
      ),
      errors: [error],
    },
    {
      name: "Buffer.from of JSON bound first, then digested",
      code: inFunction(`  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const digest = await crypto.subtle.digest("SHA-256", bytes);`),
      errors: [error],
    },
    {
      name: "a hasher fed Buffer.from of JSON",
      code: inFunction(
        `  return createHash("sha256").update(Buffer.from(JSON.stringify(value))).digest("hex");`,
      ),
      errors: [error],
    },
    {
      // JSON joined with other text keeps the key-order pre-image.
      name: "a prefix joined to JSON, then encoded and digested",
      code: inFunction(`  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(prefix + JSON.stringify(value)),
  );`),
      errors: [error],
    },
    {
      name: "JSON in a template literal, bound first, then digested",
      code: inFunction(`  const bytes = encoder.encode(\`v1:\${JSON.stringify(value)}\`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);`),
      errors: [error],
    },
    {
      name: "a hasher fed a prefix joined to JSON",
      code: inFunction(`  return createHash("sha256")
    .update(\`\${kind}:\${JSON.stringify(value)}\`)
    .digest("hex");`),
      errors: [error],
    },
    {
      name: "a bound hasher fed a prefix joined to JSON",
      code: inFunction(`  const hash = createHash("sha256");
  hash.update(kind + JSON.stringify(payload));
  return hash.digest("hex");`),
      errors: [error],
    },
    {
      // Bytes bound first reach a hasher the same way they reach a digest.
      name: "Buffer.from of JSON bound first, then fed to a hasher",
      code: inFunction(`  const buf = Buffer.from(JSON.stringify(payload));
  return createHash("sha256").update(buf).digest("hex");`),
      errors: [error],
    },
    {
      name: "encoded JSON bound first, then fed to a bound hasher",
      code: inFunction(`  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const hash = createHash("sha256");
  hash.update(bytes);
  return hash.digest("hex");`),
      errors: [error],
    },
    {
      name: "JSON text bound first, then fed to a hasher",
      code: inFunction(`  const preimage = \`\${kind}:\${JSON.stringify(payload)}\`;
  return createHash("sha256").update(preimage, "utf8").digest("hex");`),
      errors: [error],
    },
    {
      // A plain assignment is a write that reaches the use, the same as a declaration.
      name: "encoded JSON assigned after the declaration, then digested",
      code: inFunction(`  let bytes = encoder.encode(rawBody);
  if (structured) bytes = encoder.encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);`),
      errors: [error],
    },
    {
      name: "JSON after a call inside the hashed argument",
      code: inFunction(`  return createHash("sha256")
    .update(\`\${scope(kind, id)}:\${JSON.stringify(value)}\`)
    .digest("hex");`),
      errors: [error],
    },
    {
      name: "JSON after a comma in an array literal inside the hashed argument",
      code: inFunction(
        `  return createHash("sha256").update([kind, JSON.stringify(value)].join(":")).digest("hex");`,
      ),
      errors: [error],
    },

    // Holes closed by the AST port (#1378 "Holes that remain").
    {
      name: "hole 3 — an inner callback takes the encoded name, and a later use is still read",
      code: inFunction(`  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  parts.forEach((bytes) => log(bytes.length));
  const digest = await crypto.subtle.digest("SHA-256", bytes);`),
      errors: [error],
    },
    {
      name: "hole 4 — JSON in an object literal after a comma",
      code: inFunction(
        `  return createHash("sha256").update({ kind, body: JSON.stringify(value) }.body).digest("hex");`,
      ),
      errors: [error],
    },
    {
      name: "hole 4 — JSON in a second open bracket",
      code: inFunction(
        `  return createHash("sha256").update([kind, [id, JSON.stringify(value)].join("/")].join(":")).digest("hex");`,
      ),
      errors: [error],
    },
    {
      name: "hole 4 — JSON nested in another call",
      code: inFunction(
        `  return createHash("sha256").update(format([kind, JSON.stringify(value)])).digest("hex");`,
      ),
      errors: [error],
    },
    {
      name: "hole 4 — JSON after a string that holds a paren",
      code: inFunction(
        `  return createHash("sha256").update("v1(" + JSON.stringify(value)).digest("hex");`,
      ),
      errors: [error],
    },
    {
      name: "hole 4 — JSON after a string that holds a comma",
      code: inFunction(
        `  return createHash("sha256").update("a,b:" + JSON.stringify(value)).digest("hex");`,
      ),
      errors: [error],
    },
    {
      name: "hole 4 — JSON after a string that holds a semicolon",
      code: inFunction(
        `  return createHash("sha256").update("v1;" + JSON.stringify(value)).digest("hex");`,
      ),
      errors: [error],
    },
    {
      name: "hole 5 — a same-file helper whose parameter flows into a hasher",
      code: `function hashOf(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

const key = hashOf(JSON.stringify(payload));
const raw = hashOf(rawBody);`,
      errors: [helperError("hashOf")],
    },
    {
      name: "hole 5 — a same-file arrow helper whose parameter is encoded, then digested",
      code: `const digestOf = async (label: string, text: string) => {
  const bytes = new TextEncoder().encode(text);
  return crypto.subtle.digest("SHA-256", bytes);
};

const digest = await digestOf("meta", \`v1:\${JSON.stringify(meta)}\`);`,
      errors: [helperError("digestOf")],
    },

    // Decisions the AST port changes. Each catches more than the regex did.
    {
      // A write in a branch does not always run, so it does not hide the JSON above it.
      name: "a conditional reassignment to raw bytes does not hide encoded JSON",
      code: inFunction(`  let bytes = encoder.encode(JSON.stringify(meta));
  if (raw) bytes = encoder.encode(rawBody);
  const digest = await crypto.subtle.digest("SHA-256", bytes);`),
      errors: [error],
    },
    {
      // `Hash.update` returns the hasher, so a later `.update` in the chain is a sink.
      name: "JSON fed to a later update in the chain",
      code: inFunction(
        `  return createHash("sha256").update(kind).update(JSON.stringify(value)).digest("hex");`,
      ),
      errors: [error],
    },

    // Owner hashers in another file (scripts/oxlint/alfred/shared/hash-owners.ts). Each
    // case below was missed when the rule read only same-file helpers.
    {
      name: "a named import of the owner string hasher over JSON",
      code: `import { sha256Hex } from "@alfred/db/hash";

const key = sha256Hex(JSON.stringify(payload));`,
      errors: [helperError("sha256Hex")],
    },
    {
      name: "a renamed import of the owner string hasher over JSON in a template",
      code: `import { sha256Hex as digest } from "@alfred/db/hash";

const key = digest(\`v1:\${JSON.stringify(payload)}\`);`,
      errors: [helperError("digest")],
    },
    {
      name: "a namespace import of the owner module over bound JSON",
      code: `import * as hash from "@alfred/db/hash";

const body = JSON.stringify(payload);
const key = hash.sha256Hex(body);`,
      errors: [helperError("hash.sha256Hex")],
    },
    {
      // A relative specifier resolves from the file: `../hash.ts` and `../hash`.
      name: "a relative import of the owner module over JSON",
      filename: "packages/db/src/workflow/occurrence.ts",
      code: `import { sha256Hex } from "../hash.ts";
import * as owner from "../hash";

const key = sha256Hex(JSON.stringify(payload));
const other = owner.sha256Hex(JSON.stringify(payload));`,
      errors: [helperError("sha256Hex"), helperError("owner.sha256Hex")],
    },
    {
      // `canonicalJson` of a string is the string itself, so its keys stay in order.
      name: "the owner canonical hasher over JSON",
      code: `import { sha256Canonical } from "@alfred/db/hash";

const evidence = sha256Canonical({ kind, body: JSON.stringify(payload) });`,
      errors: [helperError("sha256Canonical")],
    },
    {
      // A same-file helper over an owner hasher is read like any same-file helper.
      name: "a same-file helper whose parameter flows into the owner hasher",
      code: `import { sha256Hex } from "@alfred/db/hash";

function keyOf(text: string): string {
  return sha256Hex(\`key:\${text}\`);
}

const key = keyOf(JSON.stringify(payload));
const raw = keyOf(rawBody);`,
      errors: [helperError("keyOf")],
    },
  ],
});
