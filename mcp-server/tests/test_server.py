import os
import tempfile

import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError

from server import mcp

PROJECT_DIR = "/tmp/opencode-project-a"
OTHER_PROJECT_DIR = "/tmp/opencode-project-b"
_SAMPLE_TODOS = [
    {"content": "Design the API", "priority": "high", "children": [{"content": "Write spec"}]},
    {"content": "Implement the API"},
]


@pytest.fixture(name="client")
async def client_fixture():
    with tempfile.TemporaryDirectory(prefix="improved-todo-mcp-") as temp_dir:
        os.environ["IMPROVED_TODO_DIR"] = temp_dir
        async with Client(mcp) as c:
            yield c
        os.environ.pop("IMPROVED_TODO_DIR", None)


class TestTodoTreeServer:
    async def test_list_tools(self, client: Client):
        tools = await client.list_tools()
        tool_names = [tool.name for tool in tools]

        if "todo_plan" not in tool_names:
            raise AssertionError("Expected 'todo_plan' in tool_names")
        if "todo_read" not in tool_names:
            raise AssertionError("Expected 'todo_read' in tool_names")
        if "todo_advance" not in tool_names:
            raise AssertionError("Expected 'todo_advance' in tool_names")
        if "todo_edit" not in tool_names:
            raise AssertionError("Expected 'todo_edit' in tool_names")

    async def test_plan_then_read(self, client: Client):
        plan_result = await client.call_tool(
            name="todo_plan",
            arguments={"project_dir": PROJECT_DIR, "todos": _SAMPLE_TODOS},
        )
        read_result = await client.call_tool(
            name="todo_read", arguments={"project_dir": PROJECT_DIR}
        )
        plan_text = plan_result.content[0].text
        read_text = read_result.content[0].text
        if "Design the API" not in plan_text:
            raise AssertionError("Expected 'Design the API' in plan output")
        if "Write spec" not in plan_text:
            raise AssertionError("Expected 'Write spec' in plan output")
        if "write-spec" not in plan_text:
            raise AssertionError("Expected slug 'write-spec' in plan output")
        if "Current task:" not in plan_text:
            raise AssertionError("Expected 'Current task:' in plan output")
        if plan_text != read_text:
            raise AssertionError("Expected plan and read outputs to match")

    async def test_plan_blocked_on_second_call(self, client: Client):
        await client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [{"content": "First task"}],
            },
        )
        second_result = await client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [{"content": "Overwrite attempt"}],
            },
        )
        if "already exists" not in second_result.content[0].text:
            raise AssertionError("Expected 'already exists' in second plan response")

    async def test_sessions_are_isolated(self, client: Client):
        await client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [{"content": "Project A task"}],
            },
        )
        other_result = await client.call_tool(
            name="todo_read",
            arguments={"project_dir": OTHER_PROJECT_DIR},
        )
        other_text = other_result.content[0].text
        if "Project A task" in other_text:
            raise AssertionError("Expected Project A task to be absent from other project")
        if "topLevelCount" not in other_text:
            raise AssertionError("Expected 'topLevelCount' in empty result metadata")

    async def test_advance_completes_current_task(self, client: Client):
        await client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [{"content": "First task", "priority": "high"}, {"content": "Second task"}],
            },
        )
        read_before = await client.call_tool(
            name="todo_read", arguments={"project_dir": PROJECT_DIR}
        )
        if "first-task" not in read_before.content[0].text:
            raise AssertionError("Expected 'first-task' to be current task")
        advance_result = await client.call_tool(
            name="todo_advance",
            arguments={"project_dir": PROJECT_DIR, "task_id": "first-task", "action": "complete"},
        )
        if "second-task" not in advance_result.content[0].text:
            raise AssertionError("Expected 'second-task' to appear after advancing")

    async def test_advance_rejects_wrong_task_id(self, client: Client):
        await client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [{"content": "First task"}, {"content": "Second task"}],
            },
        )
        result = await client.call_tool(
            name="todo_advance",
            arguments={
                "project_dir": PROJECT_DIR,
                "task_id": "second-task",
                "action": "complete",
            },
        )
        if "current task" not in result.content[0].text.lower():
            raise AssertionError("Expected error message about current task")

    async def test_edit_adds_and_updates_pending_tasks(self, client: Client):
        await client.call_tool(
            name="todo_plan",
            arguments={"project_dir": PROJECT_DIR,
                       "todos": [{"content": "Original task", "priority": "low"}]},
        )
        ops = [
            {"type": "add", "content": "Appended task", "priority": "high"},
            {"type": "update", "id": "original-task", "content": "Revised task", "priority": "high"},
        ]
        edit_result = await client.call_tool(
            name="todo_edit", arguments={"project_dir": PROJECT_DIR, "ops": ops}
        )
        edit_text = edit_result.content[0].text
        if "appended-task" not in edit_text:
            raise AssertionError("Expected 'appended-task' in edit output")
        if "Revised task" not in edit_text:
            raise AssertionError("Expected 'Revised task' in edit output")

    async def test_plan_rejects_invalid_priority(self, client: Client):
        with pytest.raises(ToolError):
            await client.call_tool(
                name="todo_plan",
                arguments={
                    "project_dir": PROJECT_DIR,
                    "todos": [{"content": "Task", "priority": "urgent"}],
                },
            )

    async def test_edit_rejects_status_field_in_update_op(self, client: Client):
        await client.call_tool(
            name="todo_plan",
            arguments={
                "project_dir": PROJECT_DIR,
                "todos": [{"content": "Original task"}],
            },
        )
        with pytest.raises(ToolError):
            await client.call_tool(
                name="todo_edit",
                arguments={
                    "project_dir": PROJECT_DIR,
                    "ops": [{"type": "update", "id": "original-task", "status": "completed"}],
                },
            )
