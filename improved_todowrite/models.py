from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class TodoNode(BaseModel):
    id: str
    content: str
    status: Literal["pending", "in_progress", "completed", "cancelled"]
    priority: Literal["high", "medium", "low"]
    children: list["TodoNode"] = Field(default_factory=list)


TodoNode.model_rebuild()


class TodoMetadata(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    top_level_count: int = Field(alias="topLevelCount")
    total_count: int = Field(alias="totalCount")


class TodoCommandResult(BaseModel):
    title: str
    metadata: TodoMetadata
    output: str
    todos: list[TodoNode]


class FlattenedTodoRow(BaseModel):
    session_id: str
    node_id: str
    parent_id: str | None
    content: str
    status: str
    priority: str
    depth: int
    position: int
