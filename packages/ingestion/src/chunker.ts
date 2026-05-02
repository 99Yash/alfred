/**
 * Paragraph-aware chunker.
 *
 * Strategy:
 *   1. Split content on blank-line boundaries (paragraphs).
 *   2. Greedily merge consecutive paragraphs until adding the next one
 *      would push the chunk past `targetTokens`.
 *   3. Provide a small character overlap between chunks so retrieval
 *      doesn't miss content that straddles a boundary.
 *   4. If a single paragraph is itself longer than `maxTokens`, fall
 *      back to a sentence/word split for that paragraph alone.
 *
 * Token counting is character-based at 4 chars/token — accurate enough
 * for chunk sizing without pulling in a tokenizer (gpt-tokenizer, tiktoken,
 * js-tiktoken all add real bundle weight). Voyage's 32k token context
 * means we have headroom anyway.
 *
 * Why paragraph-aware vs fixed-window: emails are paragraph-shaped. A
 * fixed-window chunker drops sentences mid-clause; paragraph splits
 * preserve the unit of thought, which embedding quality cares about.
 */

const CHARS_PER_TOKEN = 4;

export interface ChunkerOptions {
  /** Target token count per chunk. Default 1000. */
  targetTokens?: number;
  /**
   * Hard ceiling per chunk before we force a split inside a paragraph.
   * Default 1500 — gives the greedy merge slack to land near the target.
   */
  maxTokens?: number;
  /** Token overlap between consecutive chunks. Default 80. */
  overlapTokens?: number;
}

export interface Chunk {
  position: number;
  content: string;
  tokenCount: number;
}

const PARAGRAPH_SPLIT = /\n{2,}/;
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

export function chunkText(text: string, opts: ChunkerOptions = {}): Chunk[] {
  const targetTokens = opts.targetTokens ?? 1000;
  const maxTokens = opts.maxTokens ?? 1500;
  const overlapTokens = opts.overlapTokens ?? 80;

  const target = targetTokens * CHARS_PER_TOKEN;
  const max = maxTokens * CHARS_PER_TOKEN;
  const overlap = overlapTokens * CHARS_PER_TOKEN;

  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) {
    return [{ position: 0, content: trimmed, tokenCount: estimateTokens(trimmed) }];
  }

  const paragraphs = trimmed
    .split(PARAGRAPH_SPLIT)
    .map((p) => p.trim())
    .filter(Boolean);

  // Greedy merge with a hard ceiling.
  const merged: string[] = [];
  let buffer = "";
  for (const para of paragraphs) {
    if (para.length > max) {
      // Flush the buffer, then split the oversized paragraph itself.
      if (buffer) {
        merged.push(buffer);
        buffer = "";
      }
      for (const slice of splitOversized(para, max)) merged.push(slice);
      continue;
    }
    if (!buffer) {
      buffer = para;
      continue;
    }
    if (buffer.length + 2 + para.length > target) {
      merged.push(buffer);
      buffer = para;
    } else {
      buffer += "\n\n" + para;
    }
  }
  if (buffer) merged.push(buffer);

  // Apply overlap by prepending the tail of the previous chunk.
  const chunks: Chunk[] = [];
  for (let i = 0; i < merged.length; i++) {
    const prev = i > 0 ? merged[i - 1]! : "";
    const tail = prev.slice(Math.max(0, prev.length - overlap));
    const piece = i > 0 && tail ? `${tail}\n\n${merged[i]!}` : merged[i]!;
    chunks.push({ position: i, content: piece, tokenCount: estimateTokens(piece) });
  }
  return chunks;
}

function splitOversized(paragraph: string, max: number): string[] {
  // Try sentence-level split first; fall back to fixed-width slicing.
  const sentences = paragraph.split(SENTENCE_SPLIT).filter(Boolean);
  if (sentences.length === 1) return sliceByChars(paragraph, max);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (s.length > max) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      for (const piece of sliceByChars(s, max)) out.push(piece);
      continue;
    }
    if (!buf) {
      buf = s;
      continue;
    }
    if (buf.length + 1 + s.length > max) {
      out.push(buf);
      buf = s;
    } else {
      buf += " " + s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function sliceByChars(text: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

export function estimateTokens(text: string): number {
  // Rounded up so very short strings still return >=1.
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}
