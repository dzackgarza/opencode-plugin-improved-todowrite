from __future__ import annotations

import sys
from enum import StrEnum
from pathlib import Path

import typer

from improved_todowrite.core import (
    IMPROVED_TODO_DB_PATH_ENV,
    build_validation_result,
    load_todo_forest,
    parse_todo_tree_json,
    render_todo_forest,
    store_todo_forest,
)
from improved_todowrite.models import TodoCommandResult

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help=(
        "Standalone CLI for the improved hierarchical todo tree. "
        "Use this directly, or through the OpenCode plugin and MCP adapters."
    ),
    epilog=(
        f"Storage defaults to ${IMPROVED_TODO_DB_PATH_ENV} when set. "
        "Use '-' as the todos source to read JSON from stdin."
    ),
)


class OutputFormat(StrEnum):
    text = "text"
    json = "json"


def _read_todo_input(todos_source: str) -> str:
    if todos_source == "-":
        raw = sys.stdin.read()
        if not raw.strip():
            raise typer.BadParameter(
                "Standard input was empty. Pipe a JSON array or pass a file path.",
                param_hint="todos_source",
            )
        return raw

    source_path = Path(todos_source).expanduser()
    if not source_path.exists():
        raise typer.BadParameter(
            f"Todo JSON file does not exist: {source_path}",
            param_hint="todos_source",
        )
    return source_path.read_text()


def _write_result(result: TodoCommandResult, output_format: OutputFormat) -> None:
    if output_format == OutputFormat.json:
        typer.echo(result.model_dump_json(by_alias=True, indent=2))
        return
    typer.echo(result.output)


def _parse_todos(todos_source: str):
    try:
        return parse_todo_tree_json(_read_todo_input(todos_source))
    except ValueError as exc:
        raise typer.BadParameter(str(exc), param_hint="todos_source") from exc


@app.command("write")
def write_command(
    session_id: str = typer.Argument(
        ...,
        help="Session ID or other stable grouping key used to persist this todo tree.",
    ),
    todos_source: str = typer.Argument(
        ...,
        help="Path to a JSON todo array, or '-' to read the array from stdin.",
    ),
    output_format: OutputFormat = typer.Option(
        OutputFormat.text,
        "--format",
        help="Return plain text for humans or JSON for adapters.",
    ),
) -> None:
    result = store_todo_forest(session_id, _parse_todos(todos_source))
    _write_result(result, output_format)


@app.command("read")
def read_command(
    session_id: str = typer.Argument(
        ...,
        help="Session ID or stable grouping key whose stored tree should be loaded.",
    ),
    output_format: OutputFormat = typer.Option(
        OutputFormat.text,
        "--format",
        help="Return plain text for humans or JSON for adapters.",
    ),
) -> None:
    result = render_todo_forest(load_todo_forest(session_id))
    _write_result(result, output_format)


@app.command("render")
def render_command(
    todos_source: str = typer.Argument(
        ...,
        help="Path to a JSON todo array, or '-' to read the array from stdin.",
    ),
    output_format: OutputFormat = typer.Option(
        OutputFormat.text,
        "--format",
        help="Return plain text for humans or JSON for adapters.",
    ),
) -> None:
    result = render_todo_forest(_parse_todos(todos_source))
    _write_result(result, output_format)


@app.command("validate")
def validate_command(
    todos_source: str = typer.Argument(
        ...,
        help="Path to a JSON todo array, or '-' to read the array from stdin.",
    ),
    output_format: OutputFormat = typer.Option(
        OutputFormat.text,
        "--format",
        help="Return plain text for humans or JSON for adapters.",
    ),
) -> None:
    result = build_validation_result(_parse_todos(todos_source))
    _write_result(result, output_format)


def main() -> None:
    app()
