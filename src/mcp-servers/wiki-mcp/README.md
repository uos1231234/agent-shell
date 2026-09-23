# @agent-shell/wiki-mcp

Code-domain wiki MCP server for agent-shell. Zero external dependencies (pure Node.js built-ins: fs/path/url/crypto). File-as-database under `data/source/*.json`. Tool names are prefixed `wiki__` for namespace isolation.

## Quick start

```bash
# Run the MCP server (stdio JSON-RPC 2.0)
node src/mcp-servers/wiki-mcp/server.js

# Smoke test (spawns the server as a child process)
node src/mcp-servers/wiki-mcp/tests/smoke.js
```

## Card types

| type       | file              | label |
|------------|-------------------|-------|
| module     | modules.json      | 模块  |
| interface  | interfaces.json   | 接口  |
| function   | functions.json    | 函数  |
| class      | classes.json      | 类    |
| pattern    | patterns.json     | 模式  |
| concept    | concepts.json     | 概念  |

## Tools (17)

All names are prefixed with `wiki__` when registered into the agent-shell registry (the server itself exposes the bare names below; the harness applies the `server__tool` prefix).

### Query (10)
1. `search_cards` — keyword + type-filtered card search
2. `get_card` — full card by id
3. `get_relations` — relation graph around a card (depth 1-3)
4. `get_card_tree` — parent/child hierarchy tree (part_of edges)
5. `get_source` — original source snippet for a card
6. `list_cards` — list all (optionally by type)
7. `list_phases` — list story/code phases
8. `get_phase_context` — phase + its cards + relations
9. `check_doc_updates` — detect doc changes vs last sync
10. `read_raw_file` — read a raw source file

### Diff (1)
11. `diff_docs` — line-level LCS diff (two texts / two files / mixed)

### Write-back (4)
12. `add_card` — add a card (auto backup + hot reload)
13. `update_card` — partial update (cross-type move supported)
14. `remove_card` — delete card + cleanup orphan relations
15. `update_relations` — full replace of relations.json

### Code-specific (2)
16. `scan_codebase` — recursively scan a repo folder, return card suggestions (no AST; filename + export signatures + leading comments). Does NOT write — returns suggestions for the LLM to confirm.
17. `render_md` — render a card (or the whole library) to Markdown via `visualizer/export-md.js`.

## Data layout

```
data/
  source/   modules.json interfaces.json functions.json
            classes.json  patterns.json   concepts.json
            relations.json phases.json
  raw/      synced source files (for diff_docs / read_raw_file)
  backup/   timestamped backups (kept to 5 per file)
```

## Design notes

- Atomic writes: `.tmp` + `rename`.
- Write operations auto-backup all source files before mutation; old backups beyond 5 per prefix are pruned.
- After every write, the in-memory index is hot-reloaded (no process restart).
- Search scoring: alias exact +20, title exact +15, title contains +8, token in title +5, token in body +3, CJK char hits +0.5 (cap 5), fuzzy alias (Levenshtein ≤ 1) +10. No pinyin table (code domain).
