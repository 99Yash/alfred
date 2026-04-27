export interface EmbedOptions {
  dimensions?: number;
}

export async function embed(_text: string, _opts?: EmbedOptions): Promise<number[]> {
  // Stub: returns zero vector. Real Voyage implementation comes in milestone 7.
  const dim = _opts?.dimensions ?? 1024;
  return Array.from<number>({ length: dim }).fill(0);
}

export async function embedMany(_texts: string[], opts?: EmbedOptions): Promise<number[][]> {
  return Promise.all(_texts.map((t) => embed(t, opts)));
}

export const EMBEDDING_DIMENSIONS = 1024;
