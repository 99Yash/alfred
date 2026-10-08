import { INTEGRATION_ACTIONS, type IntegrationSlug } from "@alfred/contracts";

export type ToolNameEncoding = "double-underscore" | "identity";

export interface ToolNameCodec {
  readonly encoding: ToolNameEncoding;
  readonly maxLen: number;
  encode(name: string): string;
  decode(name: string): string;
}

function encodeToolName(name: string, encoding: ToolNameEncoding): string {
  return encoding === "double-underscore" ? name.replaceAll(".", "__") : name;
}

function decodeToolName(name: string, encoding: ToolNameEncoding): string {
  return encoding === "double-underscore" ? name.replaceAll("__", ".") : name;
}

const CODEC_BY_PROVIDER = {
  anthropic: { encoding: "double-underscore" as const, maxLen: 128 },
  google: { encoding: "double-underscore" as const, maxLen: 64 },
  openai: { encoding: "double-underscore" as const, maxLen: 64 },
} as const;

export function codecForProvider(provider: keyof typeof CODEC_BY_PROVIDER): ToolNameCodec {
  const { encoding, maxLen } = CODEC_BY_PROVIDER[provider];

  return {
    encoding,
    maxLen,
    encode: (name) => encodeToolName(name, encoding),
    decode: (name) => decodeToolName(name, encoding),
  };
}

export function assertToolNameRegistry(): void {
  // SAFETY: the keys are exactly the const record's own keys.
  for (const provider of Object.keys(CODEC_BY_PROVIDER) as (keyof typeof CODEC_BY_PROVIDER)[]) {
    const spec = CODEC_BY_PROVIDER[provider];
    const codec = codecForProvider(provider);

    // SAFETY: INTEGRATION_ACTIONS is keyed by exactly IntegrationSlug.
    for (const integration of Object.keys(INTEGRATION_ACTIONS) as IntegrationSlug[]) {
      const actions = INTEGRATION_ACTIONS[integration];

      for (const action of actions) {
        const name = `${integration}.${action}`;
        const encoded = codec.encode(name);

        if (
          codec.encoding === "double-underscore" &&
          (name.split(".").length !== 2 || name.includes("__"))
        ) {
          throw new Error(`${name} cannot round-trip through the provider tool-name encoding`);
        }

        if (!/^[a-zA-Z0-9_.-]+$/.test(encoded) || encoded.length > codec.maxLen) {
          throw new Error(`${name} exceeds provider ${provider} tool-name policy`);
        }

        // decode(encode(name)) must equal name.
        if (codec.decode(encoded) !== name) {
          throw new Error(`${name} failed tool-name codec round-trip for ${provider}`);
        }
      }
    }

    void spec;
  }
}

// Runs at module load.
assertToolNameRegistry();
