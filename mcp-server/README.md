[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)


# improved-todowrite MCP Server

`improved-todowrite` MCP server wraps the standalone `todowrite` CLI with FastMCP.

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

### `todo_plan`

Create the initial todo tree for a project directory.

```text
project_dir: string
todos: PlanInput[]
```

### `todo_read`

Read the current todo tree and current task for a project directory.

```text
project_dir: string
```

### `todo_advance`

Advance the current task in order.

```text
project_dir: string
id: string
action: "complete" | "cancel"
reason?: string
```

### `todo_edit`

Make surgical changes to pending parts of the todo tree.

```text
project_dir: string
ops: EditOp[]
```

Hashing `project_dir` generates a stable synthetic session ID. This allows MCP callers to retrieve the same persisted tree.
