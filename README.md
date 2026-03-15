[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)

# improved-todowrite

`improved-todowrite` is a CLI-first hierarchical todo tree tool. The standalone Typer CLI is the product surface; the OpenCode plugin and MCP server are thin adapters over the same canonical implementation.

## CLI First

Run the CLI directly with `uvx`:

```bash
uvx --from git+https://github.com/dzackgarza/opencode-plugin-improved-todowrite.git improved-todowrite --help
```

Core commands:

```bash
improved-todowrite write <session-id> todos.json
improved-todowrite read <session-id>
improved-todowrite render todos.json
improved-todowrite validate todos.json --format json
```

Use `-` as the todos source to read JSON from stdin:

```bash
cat todos.json | uvx --from git+https://github.com/dzackgarza/opencode-plugin-improved-todowrite.git improved-todowrite write ses_demo -
```

The CLI stores data in SQLite and reuses the same response contract everywhere:

- `title`
- `metadata.topLevelCount`
- `metadata.totalCount`
- `output`
- `todos`

## Local Setup

```bash
direnv allow .
just install
```

Use the lowercase `justfile` entrypoints for local automation.

## OpenCode Plugin

Register the plugin in OpenCode via npm or git:

```json
{
  "plugin": [
    "@dzackgarza/opencode-plugin-improved-todowrite@git+https://github.com/dzackgarza/opencode-plugin-improved-todowrite.git"
  ]
}
```

The plugin delegates read/write operations to the standalone CLI and only handles OpenCode-specific session publishing, permissions, and metadata.

## MCP Server

The MCP server also delegates to the same CLI:

```json
{
  "mcp": {
    "improved-todowrite": {
      "type": "local",
      "command": [
        "uvx",
        "--from",
        "git+https://github.com/dzackgarza/opencode-plugin-improved-todowrite.git#subdirectory=mcp-server",
        "improved-todowrite-mcp"
      ]
    }
  }
}
```

## Tool Names

### `improved_todowrite`

Use when you need to write or replace the hierarchical todo tree for the current session.

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

Use when you need to read the hierarchical todo tree for the current session.

#### Input

No arguments.

## Environment Variables

| Name | Required | Default | Controls |
|------|----------|---------|---------|
| `IMPROVED_TODO_SQLITE_PATH` | No | `~/.local/share/opencode/improved-todowrite.sqlite` | Override the SQLite path used by the CLI and adapters |
| `IMPROVED_TODO_VERIFICATION_PASSPHRASE` | No | — | Append a verification passphrase to CLI/plugin/MCP result output |
| `IMPROVED_TODOWRITE_TEST_PASSPHRASE` | No | — | Passphrase for OpenCode integration-proof runs |
| `OPENCODE_CONFIG` | No | `$PWD/.config/opencode.json` | Repo-local OpenCode config for validation |
| `OPENCODE_CONFIG_DIR` | No | `$PWD/.config` | Repo-local OpenCode config directory for validation |

## Dependencies

- CLI runtime: Python 3.11+, `uv`, Typer, SQLite
- Plugin runtime: Bun, `@opencode-ai/plugin`, `uv`
- MCP wrapper: Python 3.11+, `uv`, `fastmcp`

## Checks

```bash
direnv allow .
just check
```
