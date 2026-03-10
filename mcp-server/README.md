
# improved-todowrite MCP Server

`improved-todowrite` MCP server wraps `improved_todowrite` and `improved_todoread` with FastMCP.

## Installation

```bash
cd ./improved-todowrite/mcp-server
uv sync --dev
```

Run locally:

```bash
uv run improved-todowrite-mcp
```

Configure OpenCode for remote-style access using `uvx` from GitHub:

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

Write todos for a project directory.

```text
project_dir: string
todos: TodoNode[]
```

### `improved_todoread`

Read todos for a project directory.

```text
project_dir: string
```

Hashing `project_dir` generates a stable synthetic session ID. This allows MCP callers to retrieve the same persisted tree.
