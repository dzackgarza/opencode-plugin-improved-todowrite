import { tool } from "@opencode-ai/plugin";
import type { z } from "zod";

export const IMPROVED_TODOWRITE_DESCRIPTION =
  "Use when you need to write or replace the hierarchical todo tree for the current session. This plugin delegates to the standalone improved-todowrite CLI.";
export const IMPROVED_TODOREAD_DESCRIPTION =
  "Use when you need to read the hierarchical todo tree for the current session. This plugin delegates to the standalone improved-todowrite CLI.";

export type TodoTreeNode = {
  id: string;
  content: string;
  status: string;
  priority: string;
  children: TodoTreeNode[];
};

export type TodoTreeResult = {
  title: string;
  metadata: {
    topLevelCount: number;
    totalCount: number;
  };
  output: string;
  todos: TodoTreeNode[];
};

export const TodoTreeNodeSchema: z.ZodType<TodoTreeNode> = tool.schema.lazy(() =>
  tool.schema.object({
    id: tool.schema.string().describe("Stable unique ID for this todo node"),
    content: tool.schema.string().describe("Brief description of the task"),
    status: tool.schema
      .string()
      .describe(
        "Current status of the task: pending, in_progress, completed, cancelled",
      ),
    priority: tool.schema
      .string()
      .describe("Priority level of the task: high, medium, low"),
    children: tool.schema
      .array(TodoTreeNodeSchema)
      .default([])
      .describe("Nested subtasks for this todo node"),
  }),
);

function statusMarker(status: string): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[~]";
  if (status === "cancelled") return "[-]";
  return "[ ]";
}

function childSummary(children: TodoTreeNode[]): string {
  if (children.length === 0) return "";
  if (children.length === 1) return " (1 child)";
  return ` (${children.length} children)`;
}

export function summarizeTopLevelTodos(todos: TodoTreeNode[]): string[] {
  return todos.map(
    (todo) =>
      `- ${statusMarker(todo.status)} ${todo.content}${childSummary(todo.children)}`,
  );
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

function markdownLine(todo: TodoTreeNode, depth: number): string {
  return `${indent(depth)}- ${statusMarker(todo.status)} ${todo.content}`;
}

export function buildMarkdownTodoTree(todos: TodoTreeNode[]): string {
  const lines = ["# Todo Tree", ""];

  const visit = (nodes: TodoTreeNode[], depth: number): void => {
    for (const node of nodes) {
      lines.push(markdownLine(node, depth));
      visit(node.children, depth + 1);
    }
  };

  if (todos.length === 0) {
    lines.push("_No todos yet._");
  } else {
    visit(todos, 0);
  }

  return lines.join("\n");
}

export function buildTodoTreeReminder(): string {
  return [
    "<system-reminder>",
    "The full todo tree has already been displayed in chat.",
    "Refer to that displayed tree instead of repeating the full hierarchy unless the user asks for it again.",
    "</system-reminder>",
  ].join("\n");
}
