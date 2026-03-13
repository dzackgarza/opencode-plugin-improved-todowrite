[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)

# improved-todowrite

This OpenCode plugin stores a hierarchical todo tree for each session and exposes tree-native read/write tools.

## Install

Install the plugin from its directory:

```bash
cd ./improved-todowrite
direnv allow .
just install
```

Use the lowercase `justfile` entrypoints for local automation. Do not run `bun test`, `bunx tsc`, or `uv run pytest` directly.

Register the plugin in OpenCode via `file:`:

```json
{
  "plugin": [
    "file:///path/to/improved-todowrite/src/index.ts"
  ]
}
```

See the sample local configuration: [`improved-todowrite/.config/opencode.json`](./improved-todowrite/.config/opencode.json).

### Verification

Verification uses the package `.envrc` to export `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR`. To verify the installation locally:

```bash
cd ./improved-todowrite
direnv allow .
timeout 30 /path/to/opencode run --agent plugin-proof \
  "Use improved_todowrite to write one top-level todo with id=phase-1, content='Ship persistence layer', status='pending', priority='high'. Then use improved_todoread. After both tool calls finish, reply with ONLY READY."
```

If you do not use `direnv`, run the following:

```bash
OPENCODE_CONFIG=./improved-todowrite/.config/opencode.json \
  timeout 30 /path/to/opencode run --agent plugin-proof \
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
