from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
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
            },
            {
                "id": "task-2",
                "content": "Implement writes",
                "status": "pending",
                "priority": "high",
                "children": [
                    {
                        "id": "subtask-1",
                        "content": "Add transaction wrapper",
                        "status": "pending",
                        "priority": "medium",
                        "children": [],
                    }
                ],
            },
        ],
    },
    {
        "id": "phase-2",
        "content": "Add MCP coverage",
        "status": "pending",
        "priority": "medium",
        "children": [],
    },
]


def run_cli(*args: str, stdin_text: str = "", env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    return subprocess.run(
        ["uv", "run", "improved-todowrite", *args],
        cwd=REPO_ROOT,
        env=merged_env,
        input=stdin_text,
        text=True,
        capture_output=True,
        check=False,
    )


def test_cli_write_then_read_round_trips_a_nested_tree() -> None:
    with tempfile.TemporaryDirectory(prefix="improved-todowrite-cli-") as temp_dir:
        db_path = str(Path(temp_dir) / "todos.sqlite")
        write_result = run_cli(
            "write",
            "ses_cli",
            "-",
            "--format",
            "json",
            stdin_text=json.dumps(TODO_TREE),
            env={"IMPROVED_TODO_SQLITE_PATH": db_path},
        )
        assert write_result.returncode == 0, write_result.stderr

        read_result = run_cli(
            "read",
            "ses_cli",
            "--format",
            "json",
            env={"IMPROVED_TODO_SQLITE_PATH": db_path},
        )
        assert read_result.returncode == 0, read_result.stderr

        write_payload = json.loads(write_result.stdout)
        read_payload = json.loads(read_result.stdout)
        expected_output = "\n".join(
            [
                "Top-level todos:",
                "- [~] Ship persistence layer (2 children)",
                "- [ ] Add MCP coverage",
                "",
                "Todo tree:",
                json.dumps(TODO_TREE, indent=2),
            ]
        )

        assert write_payload == {
            "title": "2 top-level todos",
            "metadata": {
                "topLevelCount": 2,
                "totalCount": 5,
            },
            "output": expected_output,
            "todos": TODO_TREE,
        }
        assert read_payload == write_payload


def test_cli_validate_reports_canonical_counts() -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        path = Path(handle.name)
        handle.write(json.dumps(TODO_TREE))

    try:
        result = run_cli("validate", str(path), "--format", "json")
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)

        assert payload == {
            "title": "Todo tree validated",
            "metadata": {
                "topLevelCount": 2,
                "totalCount": 5,
            },
            "output": "Todo tree is valid.\nTop-level todos: 2 todos\nTotal nodes: 5 nodes",
            "todos": TODO_TREE,
        }
    finally:
        path.unlink(missing_ok=True)
