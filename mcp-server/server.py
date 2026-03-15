from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Annotated

from fastmcp import FastMCP
from pydantic import BaseModel, Field

mcp = FastMCP(
    name="improved-todowrite-mcp",
    instructions="Use when you need to read or write the hierarchical todo tree through the standalone improved-todowrite CLI.",
)

SERVER_DIR = Path(__file__).parent.resolve()
PROJECT_ROOT = SERVER_DIR.parent
LOCAL_PYPROJECT = PROJECT_ROOT / "pyproject.toml"
CLI_REPOSITORY = "git+https://github.com/dzackgarza/opencode-plugin-improved-todowrite.git"


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


def _cli_command() -> list[str]:
    if LOCAL_PYPROJECT.exists():
        return ["uv", "run", "--project", str(PROJECT_ROOT), "improved-todowrite"]
    return ["uvx", "--from", CLI_REPOSITORY, "improved-todowrite"]


def _cli_cwd() -> str:
    return str(PROJECT_ROOT if LOCAL_PYPROJECT.exists() else SERVER_DIR)


def _run_cli(command: str, args: list[str], stdin_text: str | None = None) -> dict:
    try:
        result = subprocess.run(
            [*_cli_command(), command, *args, "--format", "json"],
            cwd=_cli_cwd(),
            capture_output=True,
            input=stdin_text,
            text=True,
            timeout=60,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "The improved-todowrite MCP adapter requires `uv` on PATH. Install uv before starting the server."
        ) from exc

    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip()
            or result.stdout.strip()
            or f"improved-todowrite {command} failed"
        )

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"improved-todowrite {command} returned invalid JSON:\n{result.stdout.strip()}"
        ) from exc


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
    """Use when you need to persist the hierarchical todo tree for a stable project grouping."""
    session_id = _session_id_for_project_dir(project_dir)
    return _run_cli(
        "write",
        [session_id, "-"],
        stdin_text=json.dumps([todo.model_dump() for todo in todos]),
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
    """Use when you need to load the persisted hierarchical todo tree for a stable project grouping."""
    session_id = _session_id_for_project_dir(project_dir)
    return _run_cli("read", [session_id])


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
