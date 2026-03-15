import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastmcp import Client

sys.path.insert(0, str(Path(__file__).parent.parent))
from server import mcp

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
