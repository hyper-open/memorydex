/** Configuration for a remote vector store (mode=remote). */
export interface VectorStoreConfig {
  /** Backend kind. Currently 'qdrant'. */
  readonly kind: 'qdrant'
  /** Base URL, e.g. http://127.0.0.1:6333. */
  readonly url?: string
  /** Collection name. */
  readonly collection?: string
  /** API key (Qdrant `api-key` header), if the server requires one. */
  readonly apiKey?: string
  /** Vector dimension expected by the collection (default 1024, matches bge-m3). */
  readonly dim?: number
}

/** Default remote config. */
export const DEFAULT_VECTOR: VectorStoreConfig = {
  kind: 'qdrant',
  url: 'http://127.0.0.1:6333',
  collection: 'memorydex',
  dim: 1024,
}
