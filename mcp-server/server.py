"""
FastMCP wrapper for improved-todowrite.

Usage:
    uv run fastmcp run server.py
"""

import json
import hashlib
import subprocess
from pathlib import Path
from typing import Annotated

from fastmcp import FastMCP
from pydantic import BaseModel, Field

mcp = FastMCP(
    name="improved-todowrite-mcp",
    instructions="Use when you need to read or write the hierarchical todo tree stored for an OpenCode session.",
)

SERVER_DIR = Path(__file__).parent.resolve()
PROJECT_ROOT = SERVER_DIR.parent
MCP_SHIM = PROJECT_ROOT.parent / "opencode-plugin-mcp-shim" / "run-tool.ts"
PLUGIN_ENTRY = PROJECT_ROOT / "src" / "index.ts"


class TodoNode(BaseModel):
    id: str = Field(description="Stable unique ID for this todo node")
    content: str = Field(description="Brief description of the task")
    status: str = Field(
        description="Current status of the task: pending, in_progress, completed, cancelled"
    )
    priority: str = Field(description="Priority level of the task: high, medium, low")
    children: list["TodoNode"] = Field(
        default_factory=list, description="Nested subtasks for this todo node"
    )


TodoNode.model_rebuild()


def _session_id_for_project_dir(project_dir: str) -> str:
    normalized = str(Path(project_dir).expanduser().resolve())
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return f"mcp_proj_{digest}"


def _run_tool(tool_name: str, args: dict) -> str | dict:
    cmd = [
        "bun",
        "--no-deps",
        "run",
        str(MCP_SHIM),
        str(PLUGIN_ENTRY),
        tool_name,
        json.dumps(args),
    ]

    result = subprocess.run(
        cmd,
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=30,
    )

    if result.returncode != 0:
        return f"Error executing {tool_name}: {result.stderr}"

    stdout = result.stdout.strip()
    if not stdout:
        return ""

    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return stdout


@mcp.tool(
    annotations={
        "title": "Write Todo Tree",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def improved_todowrite(
    project_dir: Annotated[
        str,
        Field(
            description="Absolute or stable project directory path used to group todos into one synthetic session"
        ),
    ],
    todos: Annotated[
        list[TodoNode],
        Field(description="Top-level nodes of the todo tree for the current session"),
    ],
):
    """Use when you need to persist the hierarchical todo tree for the current session."""
    session_id = _session_id_for_project_dir(project_dir)
    return _run_tool(
        "improved_todowrite",
        {
            "__mcp_session_id": session_id,
            "todos": [todo.model_dump() for todo in todos],
        },
    )


@mcp.tool(
    annotations={
        "title": "Read Todo Tree",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
)
async def improved_todoread(
    project_dir: Annotated[
        str,
        Field(
            description="Absolute or stable project directory path used to load the synthetic MCP session"
        ),
    ],
):
    """Use when you need to load the persisted hierarchical todo tree for the current session."""
    session_id = _session_id_for_project_dir(project_dir)
    return _run_tool("improved_todoread", {"__mcp_session_id": session_id})


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
