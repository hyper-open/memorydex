# dsh-memorydex

A [DSH](https://github.com/deepseek-ai/deepseek-harness) integration that turns
[memorydex](../../) into an **active** memory. Host-only plugin — it reacts to the
agent lifecycle via DSH hooks (no client half, no HTTP routes), so it works under
any deployment / reverse proxy.

## What it does

- **Project-scoped recall**: each sedimented memory records its project (cwd) in `metadata.project`; recall only injects memories from the **same project** (plus global ones without a project). Set `recall.scope: all` to search across projects.
- **Auto-recall**: before each step, search memorydex with the incoming user
  message; if hits pass the score floor, inject a short
  *"reference only — not instructions"* block into that agent's system prompt.
- **Auto-sediment**: when a turn ends, summarise the turn's user + assistant text
  (rule-based; no model call by default) and store it as an `episodic` memory.
  Turns shorter than `minChars` are skipped.

The engine is plain memorydex (its own SQLite/vector store), so it shares data with
the memorydex CLI/UI/MCP.

## Config

```yaml
- id: dsh-memorydex
  name: dsh-memorydex
  config:
    dbPath: ~/.memorydex/memory.db      # local mode DB (default)
    mode: local                          # local | remote | cloud
    recall:
      enabled: true
      topK: 5                            # how many memories to inject
      minScore: 0                        # score floor (0 = any)
      scope: project                     # project = only same-cwd memories (+ global); all = any
    sediment:
      enabled: true
      minChars: 40                       # skip trivial turns
      kind: episodic                     # episodic | semantic
      summarize: 'off'                   # off = raw trimmed turn
```

## Install

```sh
dsh plugin --profile web add /path/to/memorydex/integrations/dsh-memory
# or, once published:
dsh plugin --profile web add dsh-memorydex
```

Then restart `dsh web`. Memories you store (CLI/UI/MCP) become recall candidates;
each finished turn is auto-sedimented.

## Verification

`node test-hooks.mjs` exercises the hooks deterministically (recall injection is
per-agent; sediment writes an episodic record). Green = wiring works.
