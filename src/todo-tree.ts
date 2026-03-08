import { Database } from "bun:sqlite";
import { tool } from "@opencode-ai/plugin";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { z } from "zod";

const IMPROVED_TODO_DB_PATH_ENV = "IMPROVED_TODO_SQLITE_PATH";
const IMPROVED_TODO_VERIFICATION_PASSPHRASE_ENV =
  "IMPROVED_TODO_VERIFICATION_PASSPHRASE";
const DEFAULT_TODO_DB_PATH = join(
  process.env.HOME ?? "/tmp",
  ".local",
  "share",
  "opencode",
  "improved-todowrite.sqlite",
);

export const IMPROVED_TODOWRITE_DESCRIPTION =
  "Use when you need to write or replace the hierarchical todo tree for the current session. Prefer this over flat todos for long or complex work that benefits from phases, tasks, and subtasks.";
export const IMPROVED_TODOREAD_DESCRIPTION =
  "Use when you need to read the hierarchical todo tree for the current session. Use this to recover the current plan structure before extending or updating it.";

export type TodoTreeNode = {
  id: string;
  content: string;
  status: string;
  priority: string;
  children: TodoTreeNode[];
};

export type FlattenedTodoRow = {
  sessionID: string;
  nodeID: string;
  parentID: string | null;
  content: string;
  status: string;
  priority: string;
  depth: number;
  position: number;
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

export const TodoTreeArgsSchema = tool.schema.object({
  todos: tool.schema
    .array(TodoTreeNodeSchema)
    .describe("Top-level nodes of the todo tree for the current session"),
});

let todoDatabase: Database | undefined;
let todoDatabasePath: string | undefined;

function resolveTodoDatabasePath(): string {
  const configured = process.env[IMPROVED_TODO_DB_PATH_ENV]?.trim();
  if (configured) return configured;
  return DEFAULT_TODO_DB_PATH;
}

function initializeTodoSchema(database: Database): void {
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA foreign_keys = OFF");
  database.run(`
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
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS improved_todo_nodes_session_parent_position
    ON improved_todo_nodes (session_id, parent_id, position)
  `);
}

function getTodoDatabase(): Database {
  const databasePath = resolveTodoDatabasePath();
  if (todoDatabase && todoDatabasePath === databasePath) {
    return todoDatabase;
  }

  todoDatabase?.close(false);
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath, { create: true, strict: true });
  initializeTodoSchema(database);
  todoDatabase = database;
  todoDatabasePath = databasePath;
  return database;
}

export function resetTodoStoreForTesting(): void {
  todoDatabase?.close(false);
  todoDatabase = undefined;
  todoDatabasePath = undefined;
}

function collectNodeIDs(
  nodes: TodoTreeNode[],
  ids: Set<string>,
  ancestry: Set<string>,
): void {
  for (const node of nodes) {
    if (ids.has(node.id)) {
      throw new Error(`Duplicate todo node id: ${node.id}`);
    }
    if (ancestry.has(node.id)) {
      throw new Error(`Cycle detected at todo node id: ${node.id}`);
    }
    ids.add(node.id);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(node.id);
    collectNodeIDs(node.children, ids, nextAncestry);
  }
}

export function validateTodoTree(todos: TodoTreeNode[]): void {
  TodoTreeArgsSchema.parse({ todos });
  collectNodeIDs(todos, new Set<string>(), new Set<string>());
}

export function flattenTodoTree(
  sessionID: string,
  todos: TodoTreeNode[],
): FlattenedTodoRow[] {
  validateTodoTree(todos);

  const rows: FlattenedTodoRow[] = [];
  const visit = (
    nodes: TodoTreeNode[],
    parentID: string | null,
    depth: number,
  ): void => {
    nodes.forEach((node, position) => {
      rows.push({
        sessionID,
        nodeID: node.id,
        parentID,
        content: node.content,
        status: node.status,
        priority: node.priority,
        depth,
        position,
      });
      visit(node.children, node.id, depth + 1);
    });
  };

  visit(todos, null, 0);
  return rows;
}

export function hydrateTodoTree(rows: FlattenedTodoRow[]): TodoTreeNode[] {
  const childrenByParent = new Map<string | null, FlattenedTodoRow[]>();
  for (const row of rows) {
    const group = childrenByParent.get(row.parentID) ?? [];
    group.push(row);
    childrenByParent.set(row.parentID, group);
  }

  const sortRows = (input: FlattenedTodoRow[]) =>
    [...input].sort(
      (left, right) =>
        left.position - right.position || left.nodeID.localeCompare(right.nodeID),
    );

  const build = (parentID: string | null): TodoTreeNode[] =>
    sortRows(childrenByParent.get(parentID) ?? []).map((row) => ({
      id: row.nodeID,
      content: row.content,
      status: row.status,
      priority: row.priority,
      children: build(row.nodeID),
    }));

  return build(null);
}

export function storeTodoForest(
  sessionID: string,
  todos: TodoTreeNode[],
): void {
  const rows = flattenTodoTree(sessionID, todos);
  const database = getTodoDatabase();
  const deleteStatement = database.query(
    "DELETE FROM improved_todo_nodes WHERE session_id = ?1",
  );
  const insertStatement = database.query(
    `INSERT INTO improved_todo_nodes (
      session_id,
      node_id,
      parent_id,
      content,
      status,
      priority,
      depth,
      position
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  );

  const writeTransaction = database.transaction(() => {
    deleteStatement.run(sessionID);
    for (const row of rows) {
      insertStatement.run(
        row.sessionID,
        row.nodeID,
        row.parentID,
        row.content,
        row.status,
        row.priority,
        row.depth,
        row.position,
      );
    }
  });
  writeTransaction();
}

export function loadTodoForest(sessionID: string): TodoTreeNode[] {
  const database = getTodoDatabase();
  const rows = database
    .query<FlattenedTodoRow, [string]>(
      `SELECT
        session_id AS sessionID,
        node_id AS nodeID,
        parent_id AS parentID,
        content,
        status,
        priority,
        depth,
        position
      FROM improved_todo_nodes
      WHERE session_id = ?1`,
    )
    .all(sessionID);
  return hydrateTodoTree(rows);
}

export function countTodoNodes(todos: TodoTreeNode[]): number {
  return todos.reduce(
    (total, todo) => total + 1 + countTodoNodes(todo.children),
    0,
  );
}

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

export function buildTodoTreeResult(todos: TodoTreeNode[]) {
  const verificationPassphrase =
    process.env[IMPROVED_TODO_VERIFICATION_PASSPHRASE_ENV]?.trim() ?? "";
  const lines = [
    "Top-level todos:",
    ...summarizeTopLevelTodos(todos),
    "",
    "Todo tree:",
    JSON.stringify(todos, null, 2),
  ];
  if (verificationPassphrase) {
    lines.push("", `Verification passphrase: ${verificationPassphrase}`);
  }

  return {
    title: `${todos.length} top-level todos`,
    metadata: {
      topLevelCount: todos.length,
      totalCount: countTodoNodes(todos),
    },
    output: lines.join("\n"),
  };
}

export function setToolDisplayMetadata(
  context: {
    metadata(input: {
      title?: string;
      metadata?: Record<string, unknown>;
    }): void;
  },
  todos: TodoTreeNode[],
): string {
  const result = buildTodoTreeResult(todos);
  context.metadata({
    title: result.title,
    metadata: result.metadata,
  });
  return result.output;
}
