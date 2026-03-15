from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from improved_todowrite.models import FlattenedTodoRow, TodoCommandResult, TodoMetadata, TodoNode

IMPROVED_TODO_DB_PATH_ENV = "IMPROVED_TODO_SQLITE_PATH"
IMPROVED_TODO_VERIFICATION_PASSPHRASE_ENV = "IMPROVED_TODO_VERIFICATION_PASSPHRASE"
DEFAULT_TODO_DB_PATH = Path.home() / ".local" / "share" / "opencode" / "improved-todowrite.sqlite"

TODO_TREE_ADAPTER = TypeAdapter(list[TodoNode])


def resolve_database_path(database_path: Path | None = None) -> Path:
    if database_path is not None:
        return database_path.expanduser().resolve()
    configured = os.environ.get(IMPROVED_TODO_DB_PATH_ENV, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return DEFAULT_TODO_DB_PATH


def connect_database(database_path: Path | None = None) -> sqlite3.Connection:
    resolved = resolve_database_path(database_path)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(resolved)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    return connection


def initialize_schema(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA foreign_keys = OFF")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS improved_todo_nodes (
          session_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          parent_id TEXT,
          content TEXT NOT NULL,
          status TEXT NOT NULL,
          priority TEXT NOT NULL,
          depth INTEGER NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (session_id, node_id)
        )
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS improved_todo_nodes_session_parent_position
        ON improved_todo_nodes (session_id, parent_id, position)
        """
    )


def parse_todo_tree_json(raw_json: str) -> list[TodoNode]:
    try:
        data = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Todo JSON must be valid JSON: {exc}") from exc

    try:
        todos = TODO_TREE_ADAPTER.validate_python(data)
    except ValidationError as exc:
        raise ValueError(f"Todo JSON does not match the expected schema: {exc}") from exc

    validate_todo_tree(todos)
    return todos


def _collect_node_ids(nodes: list[TodoNode], ids: set[str], ancestry: set[str]) -> None:
    for node in nodes:
        if node.id in ids:
            raise ValueError(f"Duplicate todo node id: {node.id}")
        if node.id in ancestry:
            raise ValueError(f"Cycle detected at todo node id: {node.id}")

        ids.add(node.id)
        next_ancestry = set(ancestry)
        next_ancestry.add(node.id)
        _collect_node_ids(node.children, ids, next_ancestry)


def validate_todo_tree(todos: list[TodoNode]) -> list[TodoNode]:
    _collect_node_ids(todos, set(), set())
    return todos


def flatten_todo_tree(session_id: str, todos: list[TodoNode]) -> list[FlattenedTodoRow]:
    validate_todo_tree(todos)
    rows: list[FlattenedTodoRow] = []

    def visit(nodes: list[TodoNode], parent_id: str | None, depth: int) -> None:
        for position, node in enumerate(nodes):
            rows.append(
                FlattenedTodoRow(
                    session_id=session_id,
                    node_id=node.id,
                    parent_id=parent_id,
                    content=node.content,
                    status=node.status,
                    priority=node.priority,
                    depth=depth,
                    position=position,
                )
            )
            visit(node.children, node.id, depth + 1)

    visit(todos, None, 0)
    return rows


def hydrate_todo_tree(rows: list[FlattenedTodoRow]) -> list[TodoNode]:
    children_by_parent: dict[str | None, list[FlattenedTodoRow]] = {}
    for row in rows:
        children_by_parent.setdefault(row.parent_id, []).append(row)

    def build(parent_id: str | None) -> list[TodoNode]:
        sorted_rows = sorted(
            children_by_parent.get(parent_id, []),
            key=lambda row: (row.position, row.node_id),
        )
        return [
            TodoNode(
                id=row.node_id,
                content=row.content,
                status=row.status,
                priority=row.priority,
                children=build(row.node_id),
            )
            for row in sorted_rows
        ]

    return build(None)


def store_todo_forest(
    session_id: str,
    todos: list[TodoNode],
    *,
    database_path: Path | None = None,
) -> TodoCommandResult:
    rows = flatten_todo_tree(session_id, todos)
    connection = connect_database(database_path)
    try:
        with connection:
            connection.execute(
                "DELETE FROM improved_todo_nodes WHERE session_id = ?",
                (session_id,),
            )
            connection.executemany(
                """
                INSERT INTO improved_todo_nodes (
                  session_id,
                  node_id,
                  parent_id,
                  content,
                  status,
                  priority,
                  depth,
                  position
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        row.session_id,
                        row.node_id,
                        row.parent_id,
                        row.content,
                        row.status,
                        row.priority,
                        row.depth,
                        row.position,
                    )
                    for row in rows
                ],
            )
    finally:
        connection.close()

    return build_todo_tree_result(todos)


def load_todo_forest(
    session_id: str,
    *,
    database_path: Path | None = None,
) -> list[TodoNode]:
    connection = connect_database(database_path)
    try:
        rows = [
            FlattenedTodoRow(
                session_id=row["session_id"],
                node_id=row["node_id"],
                parent_id=row["parent_id"],
                content=row["content"],
                status=row["status"],
                priority=row["priority"],
                depth=row["depth"],
                position=row["position"],
            )
            for row in connection.execute(
                """
                SELECT
                  session_id,
                  node_id,
                  parent_id,
                  content,
                  status,
                  priority,
                  depth,
                  position
                FROM improved_todo_nodes
                WHERE session_id = ?
                """,
                (session_id,),
            ).fetchall()
        ]
    finally:
        connection.close()

    return hydrate_todo_tree(rows)


def render_todo_forest(todos: list[TodoNode]) -> TodoCommandResult:
    validate_todo_tree(todos)
    return build_todo_tree_result(todos)


def count_todo_nodes(todos: list[TodoNode]) -> int:
    return sum(1 + count_todo_nodes(todo.children) for todo in todos)


def status_marker(status: str) -> str:
    if status == "completed":
        return "[x]"
    if status == "in_progress":
        return "[~]"
    if status == "cancelled":
        return "[-]"
    return "[ ]"


def child_summary(children: list[TodoNode]) -> str:
    if len(children) == 0:
        return ""
    if len(children) == 1:
        return " (1 child)"
    return f" ({len(children)} children)"


def summarize_top_level_todos(todos: list[TodoNode]) -> list[str]:
    return [
        f"- {status_marker(todo.status)} {todo.content}{child_summary(todo.children)}"
        for todo in todos
    ]


def build_todo_tree_result(todos: list[TodoNode]) -> TodoCommandResult:
    verification_passphrase = os.environ.get(
        IMPROVED_TODO_VERIFICATION_PASSPHRASE_ENV,
        "",
    ).strip()
    lines = [
        "Top-level todos:",
        *summarize_top_level_todos(todos),
        "",
        "Todo tree:",
        json.dumps([todo.model_dump(mode="json") for todo in todos], indent=2),
    ]
    if verification_passphrase:
        lines.extend(["", f"Verification passphrase: {verification_passphrase}"])

    return TodoCommandResult(
        title=f"{len(todos)} top-level todos",
        metadata=TodoMetadata(
            top_level_count=len(todos),
            total_count=count_todo_nodes(todos),
        ),
        output="\n".join(lines),
        todos=todos,
    )


def build_validation_result(todos: list[TodoNode]) -> TodoCommandResult:
    validate_todo_tree(todos)
    total_count = count_todo_nodes(todos)
    suffix = "node" if total_count == 1 else "nodes"
    top_level_suffix = "todo" if len(todos) == 1 else "todos"
    return TodoCommandResult(
        title="Todo tree validated",
        metadata=TodoMetadata(
            top_level_count=len(todos),
            total_count=total_count,
        ),
        output=(
            "Todo tree is valid.\n"
            f"Top-level todos: {len(todos)} {top_level_suffix}\n"
            f"Total nodes: {total_count} {suffix}"
        ),
        todos=todos,
    )


def project_dir_session_id(project_dir: str) -> str:
    normalized = str(Path(project_dir).expanduser().resolve())
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return f"mcp_proj_{digest}"
