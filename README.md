# improved-todowrite

OpenCode plugin that stores a hierarchical todo tree per session and exposes tree-native read/write tools.

## Install

```bash
cd /home/dzack/opencode-plugins/improved-todowrite
just install
```

OpenCode plugin registration via `file:`:

```json
{
  "plugin": [
    "file:///home/dzack/opencode-plugins/improved-todowrite/src/index.ts"
  ]
}
```

Sample local config: [`improved-todowrite/.config/opencode.json`](/home/dzack/opencode-plugins/improved-todowrite/.config/opencode.json)

Local one-shot verification uses the package `.envrc`, which exports `OPENCODE_CONFIG` to that sample config.

Canonical local proof path:

```bash
cd /home/dzack/opencode-plugins/improved-todowrite
direnv allow
timeout 30 /home/dzack/.opencode/bin/opencode run --agent Minimal \
  "Use improved_todowrite to write one top-level todo with id=phase-1, content='Ship persistence layer', status='pending', priority='high'. Then use improved_todoread. After both tool calls finish, reply with ONLY READY."
```

Fallback without `direnv`:

```bash
OPENCODE_CONFIG=/home/dzack/opencode-plugins/improved-todowrite/.config/opencode.json \
  timeout 30 /home/dzack/.opencode/bin/opencode run --agent Minimal \
  "Use improved_todowrite to write one top-level todo with id=phase-1, content='Ship persistence layer', status='pending', priority='high'. Then use improved_todoread. After both tool calls finish, reply with ONLY READY."
```

MCP install:

```json
{
  "mcp": {
    "improved-todowrite": {
      "type": "local",
      "command": [
        "uvx",
        "--from",
        "git+https://github.com/dzack/opencode-plugins#subdirectory=improved-todowrite/mcp-server",
        "improved-todowrite-mcp"
      ]
    }
  }
}
```

## Tool Names

### `improved_todowrite`

Description shown to the agent:

```text
Use when you need to write or replace the hierarchical todo tree for the current session. Prefer this over flat todos for long or complex work that benefits from phases, tasks, and subtasks.
```

Schema:

```text
todos: TodoTreeNode[]

TodoTreeNode:
  id: string
  content: string
  status: string
  priority: string
  children: TodoTreeNode[]
```

### `improved_todoread`

Description shown to the agent:

```text
Use when you need to read the hierarchical todo tree for the current session. Use this to recover the current plan structure before extending or updating it.
```

Schema:

```text
{}
```

## Dependencies

- Runtime: Bun, SQLite via `bun:sqlite`, `@opencode-ai/plugin`
- MCP wrapper: Python 3.11+, `uv`, `fastmcp`
- Shared helper: [`mcp-shim/run-tool.ts`](/home/dzack/opencode-plugins/mcp-shim/run-tool.ts)

## Checks

```bash
just typecheck
just test
just mcp-test
```
