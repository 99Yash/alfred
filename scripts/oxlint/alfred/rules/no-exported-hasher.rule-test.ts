import { RuleTester } from "oxlint/plugins-dev";

import { noExportedHasherRule } from "./no-exported-hasher.ts";

// The spec of `no-exported-hasher`. Each export form of a function whose parameter
// flows into a raw digest is a must-catch case, and so is each re-export of an owner
// hasher. The owner module, a private helper, and a function that hashes through the
// owner hasher are must-ignore cases.
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid` case
// without a `filename` through the root `.oxlintrc.json`.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const exported = (name: string) => ({ messageId: "exportedHasher", data: { name } });

const reexported = (name: string) => ({ messageId: "reexportedHasher", data: { name } });

tester.run("alfred/no-exported-hasher", noExportedHasherRule, {
  valid: [
    {
      // The owner module defines and exports the hashers.
      name: "the owner module exports its hashers",
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
      // A private helper is in reach of alfred/sha256-over-json-stringify, which reads
      // each call of it in this file.
      name: "a private helper whose parameter flows into a digest",
      code: `import { createHash } from "node:crypto";

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const VERSION_HASH = hashOf("v1");`,
    },
    {
      name: "an exported function that hashes a value it makes, not a parameter",
      code: `import { createHash, randomUUID } from "node:crypto";

export function freshToken(prefix: string): string {
  return \`\${prefix}:\${createHash("sha256").update(randomUUID()).digest("hex")}\`;
}`,
    },
    {
      // A function that hashes its input through the owner hasher is a normal domain
      // function. The rule cannot tell it from a wrapper, so it is out of reach (see
      // "Out of reach" in the rule comment).
      name: "an exported function that hashes its parameter through the owner hasher",
      code: `import { sha256Hex } from "@alfred/db/hash";

export function traceId(runId: string): string {
  return sha256Hex(runId).slice(0, 32);
}`,
    },
    {
      // A MAC is not a content hash, and a Drizzle update is not a hasher.
      name: "an exported HMAC and an exported database update",
      code: `import { createHmac } from "node:crypto";

export function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function rename(id: string, title: string): Promise<void> {
  await db.update(threads).set({ title }).where(eq(threads.id, id));
}`,
    },
    {
      // A #private method is not reachable from another file.
      name: "a private method of an exported class",
      code: `import { createHash } from "node:crypto";

export class Vault {
  #keyId(key: Uint8Array): string {
    return createHash("sha256").update(key).digest("hex");
  }

  open(): string {
    return this.#keyId(new Uint8Array(32));
  }
}`,
    },
    {
      // Importing an owner hasher to call it is the intended form.
      name: "an import of an owner hasher that the module only calls",
      code: `import { sha256Canonical, sha256Hex } from "@alfred/db/hash";

const key = sha256Hex(rawBody);
const evidence = sha256Canonical(payload);`,
    },
    {
      name: "a hasher in a test tree is out of scope",
      filename: "packages/assistant/test/support/hash.ts",
      code: `import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}`,
    },
  ],
  invalid: [
    {
      // `packages/corpus/src/hash.ts` before this rule.
      name: "an exported function declaration",
      code: `import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}`,
      errors: [exported("sha256")],
    },
    {
      name: "an exported const arrow and an exported function expression",
      code: `import { createHash } from "node:crypto";

export const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

export const digestOf = function (bytes: Uint8Array) {
  return crypto.subtle.digest("SHA-256", bytes);
};`,
      errors: [exported("hashOf"), exported("digestOf")],
    },
    {
      name: "a local function exposed by an export specifier, plain and renamed",
      code: `import { createHash } from "node:crypto";

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const keyOf = (text: string): string => createHash("sha256").update(text).digest("hex");

export { hashOf, keyOf as contentKey };`,
      errors: [exported("hashOf"), exported("keyOf")],
    },
    {
      name: "an anonymous default export",
      code: `import { createHash } from "node:crypto";

export default function (text: string): string {
  return createHash("sha256").update(text).digest("hex");
}`,
      errors: [exported("default")],
    },
    {
      name: "a local const exposed by a default export",
      code: `import { createHash } from "node:crypto";

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

export default hashOf;`,
      errors: [exported("hashOf")],
    },
    {
      name: "an exported object literal of functions, nested",
      code: `import { createHash } from "node:crypto";

export const hashing = {
  of(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  },
  bytes: {
    digest: (bytes: Uint8Array) => crypto.subtle.digest("SHA-256", bytes),
  },
};`,
      errors: [exported("hashing.of"), exported("hashing.bytes.digest")],
    },
    {
      name: "an object literal exposed by an export specifier",
      code: `import { createHash } from "node:crypto";

const hashing = {
  of: (text: string): string => createHash("sha256").update(text).digest("hex"),
};

export { hashing };`,
      errors: [exported("hashing.of")],
    },
    {
      name: "a method of an exported class",
      code: `import { createHash } from "node:crypto";

export class Hasher {
  of(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }
}`,
      errors: [exported("Hasher.of")],
    },
    {
      // The parameter reaches the digest through a private helper.
      name: "an exported function whose parameter reaches a private helper",
      code: `import { createHash } from "node:crypto";

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function userKey(userId: string): string {
  return hashOf(\`user:\${userId}\`);
}`,
      errors: [exported("userKey")],
    },
    {
      // A destructured parameter, a property read and a bound hasher.
      name: "an exported function that hashes a destructured or nested parameter",
      code: `import { createHash } from "node:crypto";

export function receive({ raw }: { raw: string }): string {
  const hash = createHash("sha256");
  hash.update(raw);
  return hash.digest("hex");
}

export function audit(args: { body: string }): string {
  return createHash("sha256").update(args.body).digest("hex");
}`,
      errors: [exported("receive"), exported("audit")],
    },
    {
      name: "a re-export of an owner hasher from its module",
      code: `export { sha256Hex } from "@alfred/db/hash";
export * from "@alfred/db/hash";`,
      errors: [reexported("sha256Hex"), reexported("sha256Hex, sha256Canonical")],
    },
    {
      // `packages/assistant/src/connections/mcp/hash.ts` before this rule.
      name: "an export of a local import of an owner hasher, in each form",
      code: `import { sha256Canonical, sha256Hex } from "@alfred/db/hash";

export { sha256Canonical };
export const digest = sha256Hex;
export default sha256Hex;`,
      errors: [reexported("sha256Canonical"), reexported("sha256Hex"), reexported("sha256Hex")],
    },
    {
      // A relative specifier inside the owner's package resolves to the owner.
      name: "a re-export of an owner hasher through a relative path",
      filename: "packages/db/src/index.ts",
      code: `export { sha256Hex } from "./hash";`,
      errors: [reexported("sha256Hex")],
    },
  ],
});
