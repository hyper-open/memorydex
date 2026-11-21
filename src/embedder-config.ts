/**
 * Embedder resolution from configuration, with graceful degradation.
 *
 * `embedding.kind`:
 * - `'http'`  — an OpenAI-compatible server (e.g. local bge-m3). Probed; if
 *               unreachable the resolver falls back to `'hashing'`.
 * - `'hashing'` — the built-in zero-dep embedder (offline, always works).
 * - `'off'` / `enabled:false` — no embeddings; purely lexical retrieval.
 */
import { HashingEmbedder, type Embedder } from './core/embedder.ts'
import { HttpEmbedder } from './core/http-embedder.ts'

/** Embedding configuration. */
export interface EmbeddingConfig {
  /** Whether embeddings are enabled at all (default true). */
  readonly enabled?: boolean
  /** Backend: http | hashing | off. Default 'http' when url is set, else 'hashing'. */
  readonly kind?: 'http' | 'hashing' | 'off'
  /** Full embeddings endpoint URL for kind=http. */
  readonly url?: string
  /** Model name for kind=http. */
  readonly model?: string
  /** Bearer token for kind=http. */
  readonly apiKey?: string
  /** Dim hint for kind=http (learned on probe). */
  readonly dim?: number
  /** Per-request timeout ms for kind=http. */
  readonly timeoutMs?: number
  /** Hashing dim (kind=hashing). */
  readonly hashingDim?: number
  /** When http probe fails, fall back to hashing instead of disabling (default true). */
  readonly fallbackToHashing?: boolean
}

/** Result of resolution: the chosen embedder (or undefined) plus what happened. */
export interface ResolvedEmbedder {
  readonly embedder: Embedder | undefined
  /** Effective mode actually used. */
  readonly mode: 'http' | 'hashing' | 'off'
  /** Human note (e.g. "degraded from http to hashing"). */
  readonly note?: string
}

/**
 * Resolve an embedder from config, degrading when the remote model is unavailable.
 * @param config - embedding config (undefined = default: hashing).
 */
export async function resolveEmbedder(config: EmbeddingConfig | undefined): Promise<ResolvedEmbedder> {
  const cfg = config ?? {}
  if (cfg.enabled === false || cfg.kind === 'off') return { embedder: undefined, mode: 'off' }

  const kind = cfg.kind ?? (cfg.url !== undefined ? 'http' : 'hashing')
  if (kind === 'hashing') {
    return { embedder: new HashingEmbedder(cfg.hashingDim ?? 256), mode: 'hashing' }
  }
  // kind === 'http'
  if (cfg.url === undefined || cfg.url === '') {
    return { embedder: new HashingEmbedder(cfg.hashingDim ?? 256), mode: 'hashing', note: 'no embedding url configured; using hashing' }
  }
  const http = new HttpEmbedder({ url: cfg.url, model: cfg.model, apiKey: cfg.apiKey, dim: cfg.dim, timeoutMs: cfg.timeoutMs })
  const ok = await http.probe()
  if (ok) return { embedder: http, mode: 'http' }
  if (cfg.fallbackToHashing === false) return { embedder: undefined, mode: 'off', note: 'http embedding unavailable; embeddings disabled' }
  return { embedder: new HashingEmbedder(cfg.hashingDim ?? 256), mode: 'hashing', note: `degraded: embedding server ${cfg.url} unreachable; using hashing` }
}
