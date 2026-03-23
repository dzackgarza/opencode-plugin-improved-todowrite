"""
FastMCP wrapper for improved-todowrite.

This server invokes the standalone todowrite CLI via uvx.

Usage:
    uv run fastmcp run server.py
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Annotated, Literal

from fastmcp import FastMCP
from pydantic import BaseModel, ConfigDict, Field

mcp = FastMCP(
    name="improved-todowrite-mcp",
    instructions=(
        "Use these tools to manage a hierarchical, linearly-enforced todo tree "
        "for a project. Start with todo_plan to create the initial plan. "
        "Use todo_advance to complete or cancel the current task in order. "
        "Use todo_edit for surgical replanning. Use todo_read to inspect state."
    ),
)

MANAGER_REPO = os.environ.get(
    "TODOWRITE_CLI_SPEC",
    "git+https://github.com/dzackgarza/todowrite-manager.git",
).strip()
CLI_TOOL_NAMES = {
    "todo_plan": "todo-plan",
    "todo_read": "todo-read",
    "todo_advance": "todo-advance",
    "todo_edit": "todo-edit",
}

# ─── Input models ─────────────────────────────────────────────────────────────

Priority = Literal["high", "medium", "low"]


class PlanInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(description="Brief description of the task")
    priority: Priority | None = Field(
        default=None,
        description="Priority level (high/medium/low). Defaults to medium if omitted.",
    )
    children: list[PlanInput] = Field(
        default_factory=list, description="Nested subtasks"
    )


PlanInput.model_rebuild()


class AddOp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["add"]
    parent_id: str | None = Field(
        default=None, description="ID of the parent node. Omit to add at top level."
    )
    after_id: str | None = Field(
        default=None, description="Insert after this sibling ID. Omit to append."
    )
    content: str = Field(description="Task description")
    priority: Priority | None = Field(default=None)


class UpdateOp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["update"]
    id: str = Field(description="ID of the node to update")
    content: str | None = Field(default=None)
    priority: Priority | None = Field(default=None)


class CancelOp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["cancel"]
    id: str = Field(description="ID of the node to cancel")
    reason: str = Field(
        description="Required explanation for why this task is cancelled"
    )


EditOp = Annotated[AddOp | UpdateOp | CancelOp, Field(discriminator="type")]


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _session_id_for_project_dir(project_dir: str) -> str:
    normalized = str(Path(project_dir).expanduser().resolve())
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return f"mcp_proj_{digest}"


def _run_tool(session_id: str, tool_name: str, args: dict) -> str | dict:
    cli_tool_name = CLI_TOOL_NAMES.get(tool_name, tool_name)
    cmd = [
        "uvx",
        "--from",
        MANAGER_REPO,
        "todowrite",
        "run-json",
        cli_tool_name,
        session_id,
        json.dumps(args),
    ]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=60,
    )

    if result.returncode != 0:
        return f"Error executing {tool_name}: {result.stderr or result.stdout}"

    stdout = result.stdout.strip()
    if not stdout:
        return ""

    try:
        data = json.loads(stdout)
        # Return the display output for MCP compatibility if it exists
        return data.get("display", data)
    except json.JSONDecodeError:
        return stdout


# ─── Tools ────────────────────────────────────────────────────────────────────


@mcp.tool(
    annotations={
        "title": "Create Todo Plan",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": False,
    }
)
async def todo_plan(
    project_dir: Annotated[
        str,
        Field(
            description="Absolute project directory path used to scope the todo store"
        ),
    ],
    todos: Annotated[
        list[PlanInput],
        Field(description="Top-level tasks. Each may contain nested subtasks."),
    ],
):
    """
    Create the initial hierarchical todo plan for this project.
    Blocked if a plan already exists — use todo_edit for surgical changes.
    """
    session_id = _session_id_for_project_dir(project_dir)
    return _run_tool(
        session_id,
        "todo_plan",
        {
            "todos": [t.model_dump(exclude_none=True) for t in todos],
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
async def todo_read(
    project_dir: Annotated[
        str,
        Field(
            description="Absolute project directory path used to scope the todo store"
        ),
    ],
):
    """Read the current todo tree, including which task is currently active."""
    session_id = _session_id_for_project_dir(project_dir)
    return _run_tool(session_id, "todo_read", {})


@mcp.tool(
    annotations={
        "title": "Advance Current Task",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": False,
    }
)
async def todo_advance(
    project_dir: Annotated[
        str,
        Field(
            description="Absolute project directory path used to scope the todo store"
        ),
    ],
    id: Annotated[  # noqa: A002
        str,
        Field(description="Exact ID of the current task, as shown in todo_read output"),
    ],
    action: Annotated[
        Literal["complete", "cancel"],
        Field(
            description="complete — mark done; cancel — mark cancelled with a reason"
        ),
    ],
    reason: Annotated[
        str | None,
        Field(description="Required when action is cancel"),
    ] = None,
):
    """
    Mark the current task as completed or cancelled.
    The id must match the current task exactly — this proves you know what you are completing.
    Tasks must be advanced in order; you cannot skip ahead.
    """
    session_id = _session_id_for_project_dir(project_dir)
    args: dict = {"id": id, "action": action}  # noqa: A001
    if reason is not None:
        args["reason"] = reason
    return _run_tool(session_id, "todo_advance", args)


@mcp.tool(
    annotations={
        "title": "Edit Todo Tree",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": False,
    }
)
async def todo_edit(
    project_dir: Annotated[
        str,
        Field(
            description="Absolute project directory path used to scope the todo store"
        ),
    ],
    ops: Annotated[
        list[EditOp],
        Field(
            description=(
                "Ordered list of edit operations. "
                "add: insert a new pending task. "
                + "update: change content or priority of a pending task by ID. "
                + "cancel: cancel a pending task with a required reason."
            )
        ),
    ],
):
    """
    Make surgical changes to the pending portions of the todo tree.
    Cannot change status (use todo_advance). Completed/cancelled nodes are immutable.
    """
    session_id = _session_id_for_project_dir(project_dir)
    return _run_tool(
        session_id,
        "todo_edit",
        {
            "ops": [op.model_dump(exclude_none=True) for op in ops],
        },
    )


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
