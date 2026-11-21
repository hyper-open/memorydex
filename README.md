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

The agent then gets tools: `memory_write`, `memory_search`, `memory_list`, `memory_get`, `memory_update`, `memory_delete`, `memory_stats`, `memory_import`, `memory_sync`.

## Memory model

| Kind | What it holds | Typical use |
|---|---|---|
| `working` | Short-lived, task/session-scoped scratch | current goal, temporary vars (can set `expiresAt`) |
| `episodic` | Specific events/experiences | "what I did on <date>", incident timeline |
| `semantic` | De-contextualised facts | project facts, API usage, concepts |
| `procedural` | Skills / how-to | build/test/deploy steps, SOPs |

Each record: `id, kind, title, content, tags[], importance(0-1), origin, source?, metadata, createdAt, updatedAt, expiresAt?`.

Retrieval is lexical (title/content/tag overlap) blended with importance and recency — no embeddings required, so it works on every backend and offline. Swap in vector search later without changing the model.

## Import & sync

`memorydex import <files…>` splits each Markdown file into heading-delimited sections; each section becomes a record whose `source` is `<file>#<slug>`. Section kind is inferred (commands/how-to → `procedural`, else `semantic`).

Two-way sync:
- `memorydex sync --pull [file]` — file → memory (new/changed sections create/update; removed sections delete).
- `memorydex sync --push [file]` — memory → file (rewrite the file from its records).
- Programmatic: `reconcileFile()` decides direction from a content hash.

## Configuration

Defaults to SQLite at `~/.memorydex/memory.db`, port `7567`. Override via `memorydex.config.json` or env:

```jsonc
{
  "db": { "kind": "sqlite", "path": "/path/memory.db" },
  "port": 7567,
  "host": "127.0.0.1"
}
```

Env: `MEMORYDEX_DB` (`sqlite|pg|mysql`), `MEMORYDEX_DB_PATH`, `MEMORYDEX_PORT`.

For `pg`/`mysql`: install the driver (`pg` / `mysql2`) and provide `db.url` (e.g. `postgres://user:pass@host/db`). The SQL adapter interface is `MemoryStore` (`src/db/adapter.ts`) — any backend implementing it works.

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
