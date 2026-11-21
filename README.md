# memorydex

A general-purpose AI memory system — **not tied to any single agent**. It stores four kinds of cognitive memory, can be used over **MCP** by any MCP-capable agent (DeepSeek Harness, Claude, Cursor, …), and ships its own **HTTP REST API + web UI** for visual management.

- **Four cognitive kinds**: `working` (short-lived scratch), `episodic` (events/what happened), `semantic` (facts/knowledge), `procedural` (skills/how-to).
- **Multi-database**: SQLite out of the box (zero external deps via Node's built-in `node:sqlite`); `pg`/`mysql` are pluggable adapters selected by config.
- **Write / search / manage**: programmatic API, CLI, MCP tools, and a web UI.
- **One-click import**: parse `AGENTS.md` / `CLAUDE.md` / any Markdown into memory records.
- **Two-way sync**: pull file changes into memory, or push memory edits back to the file.
- **MCP + HTTP**: connect any agent over MCP (stdio); or drive it over REST + browser UI.

## Quick start

```bash
# Install (once published) or link locally
npm install -g memorydex

# Run the web UI + REST API (default http://127.0.0.1:7567)
memorydex serve

# Run the MCP stdio server (for DSH / Claude / Cursor)
memorydex mcp

# Import existing memory files
memorydex import AGENTS.md CLAUDE.md

# Search / list / stats
memorydex search "deploy"
memorydex list --kind procedural
memorydex stats

# Watch tracked files and auto-pull changes into memory
memorydex watch
```

## Connect an agent over MCP

MCP is the universal entry point. Any agent that can run an MCP stdio server can use memorydex.

**DeepSeek Harness** (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
- insert:
    - id: memory-memorydex
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memorydex
        transport: stdio
        command: memorydex
        args: [mcp]
```

**Claude Code / Cursor / others**: add a stdio MCP server with command `memorydex`, args `["mcp"]`.

The agent then gets tools: `memory_write`, `memory_search`, `memory_list`, `memory_get`, `memory_update`, `memory_delete`, `memory_touch`, `memory_pin`, `memory_stats`, `memory_import`, `memory_sync`.

## Memory model

| Kind | What it holds | Typical use |
|---|---|---|
| `working` | Short-lived, task/session-scoped scratch | current goal, temporary vars (can set `expiresAt`) |
| `episodic` | Specific events/experiences | "what I did on <date>", incident timeline |
| `semantic` | De-contextualised facts | project facts, API usage, concepts |
| `procedural` | Skills / how-to | build/test/deploy steps, SOPs |

Each record: `id, kind, title, content, tags[], importance(0-1), origin, source?, metadata, createdAt, updatedAt, expiresAt?`.

**Retrieval** blends three signals: lexical overlap (title/content/tag), **vector similarity** (cosine over a dependency-free hashing embedding that works offline and handles CJK), plus importance, recency, access-count and a pinned bonus. Plug a real model by implementing the `Embedder` interface (`src/core/embedder.ts`) and passing it to `new MemoryService(store, embedder)`; pass `null` for pure lexical.

**Extra fields**: `links[]` (a light graph), `pinned` (always ranks first), `accessCount`/`lastAccessedAt` (bumped by `touch`), and an optional `embedding`.

## Import & sync

`memorydex import <files…>` splits each Markdown file into heading-delimited sections; each section becomes a record whose `source` is `<file>#<slug>`. Section kind is inferred (commands/how-to → `procedural`, else `semantic`).

Two-way sync:
- `memorydex sync --pull [file]` — file → memory (new/changed sections create/update; removed sections delete).
- `memorydex sync --push [file]` — memory → file (rewrite the file from its records).
- Programmatic: `reconcileFile()` decides direction from a content hash.
- **Auto-sync**: `memorydex watch [files…]` (or `watchFiles()`) watches tracked files and pulls changes into memory automatically (debounced).

## Operating modes: local / remote / cloud

Two **independent** dimensions — pick a storage mode, and separately decide whether to use vector retrieval (they compose freely; mode does not force embeddings):

```jsonc
{ "mode": "local", "db": { "kind": "sqlite" }, "embedding": { "enabled": true } }
```

| Mode | Storage | Use when |
|---|---|---|
| **local** | SQLite (bundled) | single machine, zero infra (default) |
| **remote** | external **vector store** (Qdrant) via `remote` config | large corpora / shared ANN index; needs a running Qdrant |
| **cloud** | platform-hosted API (register + API key) | *not implemented in this build — throws from `openByMode('cloud', …)`* |

- `mode` chooses **where** memories live; `embedding.enabled` + model config choose **whether/how** to do vector search. Any combination is valid: `local`+vector, `local`+lexical, `remote`+vector, `remote`+keyword-over-vector-payload, etc.
- **remote** has two backends (selected by `remote.kind`):
  - `qdrant`: `{"kind":"qdrant","url":"http://127.0.0.1:6333","collection":"memorydex","dim":1024,"apiKey":""}` — the collection auto-creates. Verified against a live Qdrant.
  - `pgvector`: `{"kind":"pgvector","url":"postgres://user:pass@host:5432/db","collection":"memorydex","dim":1024}` — needs Postgres with `CREATE EXTENSION vector`; creates the table + HNSW cosine index. Verified against Postgres + pgvector 0.8.6 (write, scroll, `<=>` ANN search).
  CLI: `--mode remote --vector-url … [--vector-key …] [--vector-collection …]` (kind from `remote.kind` in config).
- `cloud` mode is a placeholder for a future platform API (registration + key); selecting it raises a clear "not configured" error today.

## Configuration

Defaults to SQLite at `~/.memorydex/memory.db`, port `7567`. Override via `memorydex.config.json` or env:

```jsonc
{
  "db": { "kind": "sqlite", "path": "/path/memory.db" },
  "port": 7567,
  "host": "127.0.0.1"
}
```

Env: `MEMORYDEX_DB` (`sqlite|pg|mysql`), `MEMORYDEX_DB_PATH`, `MEMORYDEX_DB_URL`, `MEMORYDEX_PORT`, `MEMORYDEX_EMBED_URL`, `MEMORYDEX_EMBED_MODEL`, `MEMORYDEX_EMBED_KEY`, `MEMORYDEX_EMBED_OFF=1`.

### Embeddings (vector retrieval) — with graceful degradation

Vector retrieval is a **switch + model config**. Three modes via `embedding.kind`:

- `http` — an OpenAI-compatible embeddings server (e.g. a local **bge-m3** at `http://127.0.0.1:11434/v1/embeddings`). Probed at startup; **if unreachable it degrades to `hashing`** (or off, if `fallbackToHashing:false`).
- `hashing` — the built-in zero-dependency embedder (offline, always works).
- `off` / `enabled:false` — no embeddings; purely lexical.

```jsonc
{
  "db": { "kind": "sqlite", "path": "~/.memorydex/memory.db" },
  "embedding": {
    "enabled": true,
    "kind": "http",
    "url": "http://127.0.0.1:11434/v1/embeddings",
    "model": "bge-m3",
    "apiKey": "…",              // Bearer token if the server requires one
    "fallbackToHashing": true
  }
}
```

CLI overrides: `--embed-url <url> --embed-model <name> --embed-key <key> --embed-hashing --embed-off`. When the server is down you'll see `memorydex: degraded: … unreachable; using hashing` on stderr and retrieval keeps working. Plug any model by implementing `Embedder`.

CLI flags: `--db <sqlite|pg|mysql>`, `--db-path <sqlite file>`, `--db-url <pg/mysql url>`.

**Postgres / MySQL** are implemented adapters (tested against live PG 17 and MySQL 9). Install the driver once: `npm i pg` and/or `npm i mysql2` (they are `optionalDependencies`). Example:

```bash
memorydex --db pg --db-url 'postgres://user:pass@host:5432/db' stats
memorydex --db mysql --db-url 'mysql://user:pass@host:3306/db' stats
```

For `pg`/`mysql`: install the driver (`pg` / `mysql2`) and provide `db.url` (e.g. `postgres://user:pass@host/db`). The SQL adapter interface is `MemoryStore` (`src/db/adapter.ts`) — any backend implementing it works.

## Auto-import as platforms change

`memorydex watch-platforms` polls each adapter's discovered files and re-imports any that changed (content-hash based, debounced, idempotent thanks to write dedupe). Good for keeping the store in sync with Claude/Codex/Codebuddy/WorkBuddy files without manual imports. Programmatic: `watchPlatforms(service, registry, { intervalMs, onChange })`.

## Write audit

Every create / update / merge / delete appends a lightweight audit event (time, action, record id, summary) to an `audits` table in the same store (when the backend supports it — SQLite does). View recent events with `memorydex audit [--limit N]`, `GET /api/audit`, or the **Audit** tab in the UI. Audit writes are best-effort and never block memory writes.

## Web UI: browse, search, delete (read-only)

The web UI is **read-only for memory content**: it lists, searches, filters, shows the graph, deletes records, and offers **platform import**. Creating or editing a memory is done through the **SDK / HTTP API / MCP tools**, not the page — so a deployed UI can be handed to viewers without exposing content edits.

## Multi-platform memory (Claude / Codex / Codebuddy / WorkBuddy)

memorydex can **scan and import** the on-disk memories of several AI coding tools into one store, tagged by `platform`:

| Platform | Where its memory lives | Writable |
|---|---|---|
| Claude Code | `CLAUDE.md` (project + `~/.claude/`) | ✅ |
| Codex | `AGENTS.md` | ✅ |
| Codebuddy | `~/.codebuddy/projects/<proj>/memory/*.md` (frontmatter `name/description/type`) | ✅ |
| WorkBuddy | root `SOUL.md`/`USER.md`/`IDENTITY.md`/`MEMORY.md` + `memory/<uid>_memory.md` (embedded JSON `memoryBlock`) | ✅ (root) / ⚠️ read-only for runtime-owned `*_memory.md` |
| Generic | any `.md` | ✅ |

```bash
memorydex scan                                   # discover memory files per platform
memorydex import-platform --platform codebuddy    # import all of a platform's files
memorydex import-platform --platform workbuddy ./AGENTS.md  # or explicit files
```

In the UI: **Sync → Platforms** lists each detected platform with an Import button; the board has a **platform filter**. Records keep a stable `source` (`<file>#<slug>`), so file-based platforms remain two-way syncable.

> Note: these proprietary tools' runtime stores change without notice. Import is a best-effort read; do not write back to `*_memory.md` or private sqlite/`.info` caches.

## Write deduplication

New writes **merge into an equivalent existing record instead of duplicating**: a matching non-empty `source` key, or an identical content fingerprint (whitespace/case-insensitive) within the same kind, updates the existing record (keeps its id, bumps `updatedAt`). On by default; disable per call (`create(..., { dedupe: false })`), per CLI (`--no-dedupe`), via config `{"dedupe": false}`, or env `MEMORYDEX_DEDUPE=0`.

## Scope & limits (lightweight by design)

memorydex targets **personal / single-machine / small-team** use: one workspace's agent memory, local AGENTS.md ↔ memory upkeep, on the order of a few hundred to a few thousand records. It is intentionally **not** a multi-tenant or high-concurrency service:

- Retrieval scores in process; list/search pages are capped (`DEFAULT_LIMIT` 100, `MAX_LIMIT` 1000). For very large corpora, add DB-side indexes rather than raising the cap.
- The HTTP UI binds `127.0.0.1` by default and has **no auth** — do not expose it to untrusted networks.
- Storage is a single SQLite file by default — easy to copy/back up; see below.

### Backup / portability

```bash
memorydex export ~/memorydex-backup.json      # whole store -> JSON bundle
memorydex restore ~/memorydex-backup.json      # merge by id (safe, no duplicates)
memorydex restore ~/memorydex-backup.json --replace   # wipe then load
memorydex reembed                              # recompute embeddings after switching models
```

A SQLite deployment can also just copy the `.db` file (WAL is enabled).

## REST API

| Method & path | Purpose |
|---|---|
| `GET /api/state` | stats + kinds |
| `GET /api/memories?q=&kind=&tags=&source=&limit=` | search / list |
| `POST /api/memories` | create |
| `GET/PATCH/DELETE /api/memories/:id` | get / update / delete |
| `POST /api/import { files }` | import |
| `POST /api/sync { file?, direction }` | sync |

## Develop

```bash
npm install
npm run build     # tsc -> lib/
npm test          # node --test
npm run dev -- serve
```

## License

MIT
