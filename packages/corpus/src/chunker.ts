/**
 * Paragraph chunker: merge paragraphs up to `targetTokens`, overlap each chunk
 * with the previous tail, and split a paragraph over `maxTokens` by sentence.
 * Tokens are estimated from characters, so no tokenizer dependency is needed.
 */

import { isValidPage } from "@alfred/contracts";
import { APPROXIMATE_CHARS_PER_TOKEN } from "@alfred/ai";

export interface ChunkerOptions {
  /** Default 1000. */
  targetTokens?: number;
  /** Size that forces a split inside a paragraph. Default 1500. */
  maxTokens?: number;
  /** Default 80. */
  overlapTokens?: number;
}

export interface Chunk {
  position: number;
  content: string;
  tokenCount: number;
  /** 1-indexed PDF page. Absent for sources without pages. */
  page?: number | undefined;
}

export interface PageInput {
  /** 1-indexed page number from the extractor. */
  page: number;
  /** Markdown text for this page. */
  text: string;
}

const PARAGRAPH_SPLIT = /\n{2,}/;

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

export function chunkText(text: string, opts: ChunkerOptions = {}): Chunk[] {
  const targetTokens = opts.targetTokens ?? 1000;
  const maxTokens = opts.maxTokens ?? 1500;
  const overlapTokens = opts.overlapTokens ?? 80;

  const target = targetTokens * APPROXIMATE_CHARS_PER_TOKEN;
  const max = maxTokens * APPROXIMATE_CHARS_PER_TOKEN;
  const overlap = overlapTokens * APPROXIMATE_CHARS_PER_TOKEN;

  const trimmed = text.trim();

  if (!trimmed) return [];

  if (trimmed.length <= max) {
    return [{ position: 0, content: trimmed, tokenCount: estimateTokens(trimmed) }];
  }

  const paragraphs = trimmed
    .split(PARAGRAPH_SPLIT)
    .map((p) => p.trim())
    .filter(Boolean);

  const merged: string[] = [];
  let buffer = "";

  for (const para of paragraphs) {
    if (para.length > max) {
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

  // Overlap: prepend the previous chunk's tail.
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
  // Sentences first, then fixed-width slices.
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

/** Chunk each page on its own, so no chunk holds text from two pages (ADR-0091 D6). */
export function chunkPages(pages: readonly PageInput[], opts: ChunkerOptions = {}): Chunk[] {
  if (pages.length === 0) return [];
  const chunks: Chunk[] = [];
  let position = 0;

  for (const page of pages) {
    if (!isValidPage(page.page)) continue;
    const trimmed = page.text.trim();

    if (!trimmed) continue;
    const pageChunks = chunkText(trimmed, opts);

    for (const pc of pageChunks) {
      chunks.push({
        position: position++,
        content: pc.content,
        tokenCount: pc.tokenCount,
        page: page.page,
      });
    }
  }

  return chunks;
}

export function estimateTokens(text: string): number {
  // At least 1, even for a very short string.
  return Math.max(1, Math.ceil(text.length / APPROXIMATE_CHARS_PER_TOKEN));
}
