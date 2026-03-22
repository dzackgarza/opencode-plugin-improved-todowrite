[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)

# improved-todowrite

This OpenCode plugin stores a hierarchical todo tree for each session and exposes tree-native read/write tools.

## Features

- `improved_todowrite` — replace the full todo tree for the current session with a typed `TodoTreeNode[]` structure
- `improved_todoread` — read the current tree back before extending or updating it
- SQLite-backed persistent storage scoped to each session
- Supports nested subtasks with `status`, `priority`, and `children` fields

## Install

Install the plugin from its directory:

```bash
cd ./improved-todowrite
direnv allow .
just install
```

Use the lowercase `justfile` entrypoints for local automation. Do not run `bun test`, `bunx tsc`, or `uv run pytest` directly.

Register the plugin in OpenCode via npm:

```json
{
  "plugin": [
    "@dzackgarza/opencode-plugin-improved-todowrite@git+https://github.com/dzack/opencode-plugins#subdirectory=opencode-plugin-improved-todowrite"
  ]
}
```

### Verification

Repo-root [`opencode.json`](./opencode.json) is the canonical proof config. CI starts `opencode serve` from the repo root and relies on standard global-plus-project precedence.

CI is the canonical proof gate. For local debugging, start a repo-local OpenCode server from this checkout and set `OPENCODE_BASE_URL` before running the same `just` entrypoints:

```bash
direnv allow .
OPENCODE_BASE_URL=http://127.0.0.1:4097 just test
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

#### Input

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `todos` | `TodoTreeNode[]` | Yes | Full replacement tree |

**`TodoTreeNode`:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Stable unique ID for this node |
| `content` | `string` | Brief description of the task |
| `status` | `"pending" \| "in_progress" \| "completed" \| "cancelled"` | Current status |
| `priority` | `"high" \| "medium" \| "low"` | Priority level |
| `children` | `TodoTreeNode[]` | Nested sub-tasks |

#### Example Input

```json
{
  "todos": [
    {
      "id": "phase-1",
      "content": "Research",
      "status": "completed",
      "priority": "high",
      "children": [
        { "id": "task-1-1", "content": "Read docs", "status": "completed", "priority": "medium", "children": [] }
      ]
    }
  ]
}
```

### `improved_todoread`

Use this tool to read the hierarchical todo tree for the current session. This helps recover the current plan structure before extending or updating it.

#### Input

No arguments.

## Environment Variables

| Name | Required | Default | Controls |
|------|----------|---------|---------|
| `IMPROVED_TODOWRITE_TEST_PASSPHRASE` | No | — | Passphrase for integration test liveness proof |

## Dependencies

- Runtime: Bun, SQLite via `bun:sqlite`, `@opencode-ai/plugin`
- MCP wrapper: Python 3.11+, `uv`, `fastmcp`
- Shared helper: [`opencode-plugin-mcp-shim/run-tool.ts`](./opencode-plugin-mcp-shim/run-tool.ts)

## Checks

```bash
direnv allow .
just check
```

Use `just typecheck`, `just test`, and `just mcp-test` for targeted gates.
