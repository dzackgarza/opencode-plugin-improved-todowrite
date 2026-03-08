import json
import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastmcp import Client

sys.path.insert(0, str(Path(__file__).parent.parent))
from server import mcp


TODO_TREE = [
    {
        "id": "phase-1",
        "content": "Ship persistence layer",
        "status": "in_progress",
        "priority": "high",
        "children": [
            {
                "id": "task-1",
                "content": "Design schema",
                "status": "completed",
                "priority": "high",
                "children": [],
            }
        ],
    }
]
PROJECT_DIR = "/tmp/opencode-project-a"
OTHER_PROJECT_DIR = "/tmp/opencode-project-b"


@pytest.fixture
async def mcp_client():
    with tempfile.TemporaryDirectory(prefix="improved-todo-mcp-") as temp_dir:
        os.environ["IMPROVED_TODO_SQLITE_PATH"] = str(Path(temp_dir) / "todos.sqlite")
        async with Client(mcp) as client:
            yield client
        os.environ.pop("IMPROVED_TODO_SQLITE_PATH", None)


class TestTodoTreeServer:
    async def test_list_tools(self, mcp_client: Client):
        tools = await mcp_client.list_tools()
        tool_names = [tool.name for tool in tools]

        assert "improved_todowrite" in tool_names
        assert "improved_todoread" in tool_names

    async def test_write_then_read_tree(self, mcp_client: Client):
        write_result = await mcp_client.call_tool(
            name="improved_todowrite",
            arguments={"project_dir": PROJECT_DIR, "todos": TODO_TREE},
        )
        read_result = await mcp_client.call_tool(
            name="improved_todoread",
            arguments={"project_dir": PROJECT_DIR},
        )
        empty_other_project = await mcp_client.call_tool(
            name="improved_todoread",
            arguments={"project_dir": OTHER_PROJECT_DIR},
        )

        write_payload = json.loads(write_result.content[0].text)
        read_payload = json.loads(read_result.content[0].text)
        other_project_payload = json.loads(empty_other_project.content[0].text)
        expected_output = "\n".join(
            [
                "Top-level todos:",
                "- [~] Ship persistence layer (1 child)",
                "",
                "Todo tree:",
                json.dumps(TODO_TREE, indent=2),
            ]
        )

        assert write_payload == {
            "title": "1 top-level todos",
            "output": expected_output,
            "metadata": {
                "topLevelCount": 1,
                "totalCount": 2,
            },
        }
        assert read_payload == write_payload
        assert other_project_payload == {
            "title": "0 top-level todos",
            "output": "Top-level todos:\n\nTodo tree:\n[]",
            "metadata": {
                "topLevelCount": 0,
                "totalCount": 0,
            },
        }
