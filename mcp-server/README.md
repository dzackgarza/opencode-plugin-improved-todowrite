# improved-todowrite MCP server

FastMCP wrapper for `improved_todowrite` and `improved_todoread`.

## Install

```bash
cd /home/dzack/opencode-plugins/improved-todowrite/mcp-server
uv sync --dev
```

Local run:

```bash
uv run improved-todowrite-mcp
```

Remote-style OpenCode config using `uvx` from GitHub:

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

## MCP Tools

### `improved_todowrite`

```text
project_dir: string
todos: TodoNode[]
```

### `improved_todoread`

```text
project_dir: string
```

`project_dir` is hashed into a stable synthetic session ID so MCP callers can read back the same persisted tree.
