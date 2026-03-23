# ruff: noqa: S101
# pylint: disable=redefined-outer-name
import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError

sys.path.insert(0, str(Path(__file__).parent.parent))
from server import mcp  # noqa: E402

PROJECT_DIR = "/tmp/opencode-project-a"
OTHER_PROJECT_DIR = "/tmp/opencode-project-b"


@pytest.fixture
async def mcp_client():
    with tempfile.TemporaryDirectory(prefix="improved-todo-mcp-") as temp_dir:
        os.environ["IMPROVED_TODO_DIR"] = temp_dir
        async with Client(mcp) as client:
            yield client
        os.environ.pop("IMPROVED_TODO_DIR", None)


class TestTodoTreeServer:
    async def test_list_tools(self, mcp_client: Client):
        tools = await mcp_client.list_tools()
        tool_names = [tool.name for tool in tools]

        assert "todo_plan" in tool_names
        assert "todo_read" in tool_names
        assert "todo_advance" in tool_names
        assert "todo_edit" in tool_names

    async def test_plan_then_read(self, mcp_client: Client):
        plan_result = await mcp_client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [
                    {
                        "content": "Design the API",
                        "priority": "high",
                        "children": [{"content": "Write spec"}],
                    },
                    {"content": "Implement the API"},
                ],
            },
        )
        read_result = await mcp_client.call_tool(
            name="todo_read",
            arguments={"project_dir": PROJECT_DIR},
        )

        plan_text = plan_result.content[0].text
        read_text = read_result.content[0].text

        # Both should contain the content and current task
        assert "Design the API" in plan_text
        assert "Write spec" in plan_text
        assert "write-spec" in plan_text  # slug ID
        assert "Current task:" in plan_text
        assert plan_text == read_text

    async def test_plan_blocked_on_second_call(self, mcp_client: Client):
        await mcp_client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [{"content": "First task"}],
            },
        )
        second_result = await mcp_client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [{"content": "Overwrite attempt"}],
            },
        )
        # Should return an error string, not a plan
        assert "already exists" in second_result.content[0].text

    async def test_sessions_are_isolated(self, mcp_client: Client):
        await mcp_client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [{"content": "Project A task"}],
            },
        )
        other_result = await mcp_client.call_tool(
            name="todo_read",
            arguments={"project_dir": OTHER_PROJECT_DIR},
        )
        other_text = other_result.content[0].text
        assert "Project A task" not in other_text
        assert "topLevelCount" in other_text  # empty result still has metadata

    async def test_advance_completes_current_task(self, mcp_client: Client):
        await mcp_client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [
                    {"content": "First task", "priority": "high"},
                    {"content": "Second task"},
                ],
            },
        )
        read_before = await mcp_client.call_tool(
            name="todo_read",
            arguments={"project_dir": PROJECT_DIR},
        )
        assert "first-task" in read_before.content[0].text

        advance_result = await mcp_client.call_tool(
            name="todo_advance",
            arguments={
                "project_dir": PROJECT_DIR,
                "id": "first-task",
                "action": "complete",
            },
        )
        advance_text = advance_result.content[0].text
        assert "second-task" in advance_text

    async def test_advance_rejects_wrong_task_id(self, mcp_client: Client):
        await mcp_client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [
                    {"content": "First task"},
                    {"content": "Second task"},
                ],
            },
        )
        result = await mcp_client.call_tool(
            name="todo_advance",
            arguments={
                "project_dir": PROJECT_DIR,
                "id": "second-task",
                "action": "complete",
            },
        )
        assert "current task" in result.content[0].text.lower()

    async def test_edit_adds_and_updates_pending_tasks(self, mcp_client: Client):
        await mcp_client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [{"content": "Original task", "priority": "low"}],
            },
        )
        edit_result = await mcp_client.call_tool(
            name="todo_edit",
            arguments={
                "project_dir": PROJECT_DIR,
                "ops": [
                    {"type": "add", "content": "Appended task", "priority": "high"},
                    {
                        "type": "update",
                        "id": "original-task",
                        "content": "Revised task",
                        "priority": "high",
                    },
                ],
            },
        )
        edit_text = edit_result.content[0].text
        assert "appended-task" in edit_text
        assert "Revised task" in edit_text

    async def test_plan_rejects_invalid_priority(self, mcp_client: Client):
        with pytest.raises(ToolError):
            await mcp_client.call_tool(
                name="todo_plan",
                arguments={
                    "project_dir": PROJECT_DIR,
                    "todos": [{"content": "Task", "priority": "urgent"}],
                },
            )

    async def test_edit_rejects_status_field_in_update_op(self, mcp_client: Client):
        await mcp_client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [{"content": "Original task"}],
            },
        )
        with pytest.raises(ToolError):
            await mcp_client.call_tool(
                name="todo_edit",
                arguments={
                    "project_dir": PROJECT_DIR,
                    "ops": [
                        {
                            "type": "update",
                            "id": "original-task",
                            "status": "completed",
                        }
                    ],
                },
            )
