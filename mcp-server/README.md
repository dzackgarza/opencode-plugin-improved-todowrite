# FastMCP Server for improved-todowrite

Wrapper that exposes the tree-native `improved_todowrite` and `improved_todoread` tools via MCP.

## Installation

```bash
cd mcp-server
uv sync --dev
```

## Usage

```bash
cd mcp-server
uv run fastmcp run server.py
```

## FastMCP CLI

```bash
cd mcp-server
uv run fastmcp call server.py improved_todowrite '{"project_dir":"/path/to/project","todos":[{"id":"phase-1","content":"Ship persistence layer","status":"pending","priority":"high","children":[]}]}'
```

```bash
cd mcp-server
uv run fastmcp call server.py improved_todoread '{"project_dir":"/path/to/project"}'
```

## Notes

- OpenCode runtime uses the real `context.sessionID`.
- MCP callers must pass `project_dir`; the wrapper hashes it into a stable synthetic session ID.
- The wrapper calls the shared `mcp-shim/run-tool.ts` helper.
- Human-facing output shows top-level todos first, followed by the full persisted tree JSON.
