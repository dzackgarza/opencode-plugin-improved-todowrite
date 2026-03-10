# improved-todowrite

This OpenCode plugin stores a hierarchical todo tree for each session and exposes tree-native read/write tools.

## Install

Install the plugin from its directory:

```bash
cd /home/dzack/opencode-plugins/improved-todowrite
just install
```

Register the plugin in OpenCode via `file:`:

```json
{
  "plugin": [
    "file:///home/dzack/opencode-plugins/improved-todowrite/src/index.ts"
  ]
}
```

See the sample local configuration: [`improved-todowrite/.config/opencode.json`](/home/dzack/opencode-plugins/improved-todowrite/.config/opencode.json).

### Verification

Verification uses the package `.envrc` to export `OPENCODE_CONFIG`. To verify the installation locally:

```bash
cd /home/dzack/opencode-plugins/improved-todowrite
direnv allow
timeout 30 /home/dzack/.opencode/bin/opencode run --agent Minimal \
  "Use improved_todowrite to write one top-level todo with id=phase-1, content='Ship persistence layer', status='pending', priority='high'. Then use improved_todoread. After both tool calls finish, reply with ONLY READY."
```

If you do not use `direnv`, run the following:

```bash
OPENCODE_CONFIG=/home/dzack/opencode-plugins/improved-todowrite/.config/opencode.json \
  timeout 30 /home/dzack/.opencode/bin/opencode run --agent Minimal \
  "Use improved_todowrite to write one top-level todo with id=phase-1, content='Ship persistence layer', status='pending', priority='high'. Then use improved_todoread. After both tool calls finish, reply with ONLY READY."
```

### MCP Installation

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

Use this tool to write or replace the hierarchical todo tree for the current session. Prefer this over flat todos for complex work involving phases, tasks, and subtasks.

#### Schema

- `todos`: `TodoTreeNode[]`

**TodoTreeNode:**
- `id`: string
- `content`: string
- `status`: string
- `priority`: string
- `children`: `TodoTreeNode[]`

### `improved_todoread`

Use this tool to read the hierarchical todo tree for the current session. This helps recover the current plan structure before extending or updating it.

#### Schema

- `{}`

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
