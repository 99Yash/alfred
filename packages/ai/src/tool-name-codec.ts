import { INTEGRATION_ACTIONS, typedKeys } from "@alfred/contracts";

type ToolNameEncoding = "double-underscore" | "identity";

export interface ToolNameCodec {
  readonly encoding: ToolNameEncoding;
  readonly maxLen: number;
  readonly encode: (name: string) => string;
  readonly decode: (name: string) => string;
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

function assertToolNameRegistry(): void {
  for (const provider of typedKeys(CODEC_BY_PROVIDER)) {
    const spec = CODEC_BY_PROVIDER[provider];
    const codec = codecForProvider(provider);

    for (const integration of typedKeys(INTEGRATION_ACTIONS)) {
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
