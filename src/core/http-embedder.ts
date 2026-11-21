/**
 * OpenAI-compatible HTTP embedder (e.g. a local bge-m3 server).
 *
 * Talks to `POST <url>` (default `<base>/v1/embeddings`) with
 * `{ model, input }` and reads `data[].embedding`, OpenAI-compatible. Vectors are
 * L2-normalised so cosine == dot. Any failure surfaces to the caller so a
 * higher layer can fall back to a degraded embedder.
 */
import type { Embedder } from './embedder.ts'

/** Options for {@link HttpEmbedder}. */
export interface HttpEmbedderOptions {
  /** Full embeddings endpoint URL, e.g. http://127.0.0.1:11434/v1/embeddings. */
  readonly url: string
  /** Model name sent in the request (default 'bge-m3'). */
  readonly model?: string
  /** Bearer token, if the server requires auth. */
  readonly apiKey?: string
  /** Expected vector dimension (used before the first response; default 1024). */
  readonly dim?: number
  /** Per-request timeout in ms (default 15000). */
  readonly timeoutMs?: number
}

/** OpenAI-compatible embedder over HTTP. */
export class HttpEmbedder implements Embedder {
  readonly dim: number
  private readonly url: string
  private readonly model: string
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number
  private ready = false

  constructor(options: HttpEmbedderOptions) {
    this.url = options.url
    this.model = options.model ?? 'bge-m3'
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.dim = options.dim ?? 1024
  }

  /**
   * Probe the endpoint with a tiny request to confirm reachability + learn dim.
   * @returns true when the service responded with a usable vector.
   */
  async probe(): Promise<boolean> {
    try {
      const v = await this.embed('ping')
      if (v.length > 0) { (this as { dim: number }).dim = v.length; this.ready = true; return true }
      return false
    } catch {
      return false
    }
  }

  /** Embed one text (throws on transport/HTTP error). */
  async embed(text: string): Promise<number[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
        },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
      const json = (await res.json()) as { data?: { embedding?: number[] }[] }
      const vec = json.data?.[0]?.embedding
      if (!Array.isArray(vec)) throw new Error('embedding response missing data[0].embedding')
      return l2normalize(vec)
    } finally {
      clearTimeout(timer)
    }
  }

}

/** L2-normalise a vector (returns a new array). */
function l2normalize(vec: number[]): number[] {
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum)
  return norm === 0 ? vec : vec.map(v => v / norm)
}
