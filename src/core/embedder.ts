/**
 * Pluggable text embeddings for semantic retrieval.
 *
 * The default {@link HashingEmbedder} is dependency-free and offline: it maps a
 * text to a fixed-dimension vector via signed feature hashing of word/char n-grams,
 * giving fuzzier "semantic-ish" recall than exact terms with zero setup. Plug a
 * real model (OpenAI, local) by implementing {@link Embedder} and passing it in.
 */

/** A text embedder. */
export interface Embedder {
  /** Vector dimension produced by {@link embed}. */
  readonly dim: number
  /** Embed a single text into a unit vector. */
  embed(text: string): number[]
}

/** Deterministic signed-hashing bag-of-ngrams embedder. */
export class HashingEmbedder implements Embedder {
  /**
   * @param dim - vector dimension (default 256).
   */
  constructor(readonly dim = 256) {}

  embed(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0)
    const toks = tokenize(text)
    for (const tok of toks) {
      const h = fnv1a(tok)
      const idx = h % this.dim
      const sign = (h & 0x100) === 0 ? 1 : -1
      vec[idx] += sign
    }
    return l2normalize(vec)
  }
}

/** Lowercase word tokens plus character bigrams (helps CJK & partial matches). */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const words = lower.match(/[\p{L}\p{N}]+/gu) ?? []
  const out: string[] = [...words]
  // char bigrams for CJK / fuzzy overlap
  for (const w of words) {
    if (/[\u3400-\u9fff]/.test(w)) {
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2))
    }
  }
  return out
}

/** 32-bit FNV-1a hash. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** L2-normalise a vector in place (returns it). */
function l2normalize(vec: number[]): number[] {
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum)
  if (norm === 0) return vec
  for (let i = 0; i < vec.length; i++) vec[i] /= norm
  return vec
}

/** Cosine similarity of two equal-length vectors in [-1, 1]. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot // unit vectors → dot == cosine
}
