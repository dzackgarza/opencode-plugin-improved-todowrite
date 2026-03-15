[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)


# improved-todowrite MCP Server

`improved-todowrite` MCP server is a thin FastMCP adapter over the standalone `improved-todowrite` CLI.

## Installation

```bash
cd ./mcp-server
uv sync --dev
```

Run locally:

```bash
uv run improved-todowrite-mcp
```

The adapter shells out to the canonical CLI and returns the same JSON contract as the direct `read` and `write` commands.

Configure OpenCode for remote-style access using `uvx`:

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

Hashing `project_dir` generates a stable synthetic session ID. This allows MCP callers to retrieve the same persisted tree while reusing the canonical CLI storage path.
