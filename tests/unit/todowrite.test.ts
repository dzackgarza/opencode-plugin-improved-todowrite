import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildMarkdownTodoTree,
  buildTodoTreeReminder,
  buildTodoTreeResult,
  flattenTodoTree,
  hydrateTodoTree,
  loadTodoForest,
  resetTodoStoreForTesting,
  storeTodoForest,
  TodoTreeArgsSchema,
  type TodoTreeNode,
} from "../../src/todo-tree.ts";
import { ImprovedTodowritePlugin } from "../../src/index.ts";

const TODO_TREE: TodoTreeNode[] = [
  {
    id: "phase-1",
    content: "Ship persistence layer",
    status: "in_progress",
    priority: "high",
    children: [
      {
        id: "task-1",
        content: "Design schema",
        status: "completed",
        priority: "high",
        children: [],
      },
      {
        id: "task-2",
        content: "Implement writes",
        status: "pending",
        priority: "high",
        children: [
          {
            id: "subtask-1",
            content: "Add transaction wrapper",
            status: "pending",
            priority: "medium",
            children: [],
          },
        ],
      },
    ],
  },
  {
    id: "phase-2",
    content: "Add MCP coverage",
    status: "pending",
    priority: "medium",
    children: [],
  },
];

async function createPlugin() {
  const promptCalls: unknown[] = [];
  return ImprovedTodowritePlugin({
    client: {
      app: {
        log() {},
      },
      session: {
        async prompt(input: unknown) {
          promptCalls.push(input);
        },
      },
    } as never,
    project: {} as never,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as never,
  }).then((plugin) => ({ plugin, promptCalls }));
}

let tempDir = "";
let dbPath = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "improved-todo-test-"));
  dbPath = join(tempDir, "todos.sqlite");
  process.env.IMPROVED_TODO_SQLITE_PATH = dbPath;
  resetTodoStoreForTesting();
});

afterEach(async () => {
  resetTodoStoreForTesting();
  delete process.env.IMPROVED_TODO_SQLITE_PATH;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDir = "";
  dbPath = "";
});

describe("tree persistence helpers", () => {
  it("round-trips a nested todo tree through flattened rows", () => {
    const rows = flattenTodoTree("ses_test", TODO_TREE);
    expect(rows.map((row) => ({
      sessionID: row.sessionID,
      nodeID: row.nodeID,
      parentID: row.parentID,
      depth: row.depth,
      position: row.position,
    }))).toEqual([
      { sessionID: "ses_test", nodeID: "phase-1", parentID: null, depth: 0, position: 0 },
      { sessionID: "ses_test", nodeID: "task-1", parentID: "phase-1", depth: 1, position: 0 },
      { sessionID: "ses_test", nodeID: "task-2", parentID: "phase-1", depth: 1, position: 1 },
      { sessionID: "ses_test", nodeID: "subtask-1", parentID: "task-2", depth: 2, position: 0 },
      { sessionID: "ses_test", nodeID: "phase-2", parentID: null, depth: 0, position: 1 },
    ]);
    expect(hydrateTodoTree(rows)).toEqual(TODO_TREE);
  });

  it("persists one session independently from another", () => {
    storeTodoForest("ses_a", TODO_TREE);
    storeTodoForest("ses_b", [
      {
        id: "solo",
        content: "Unrelated task",
        status: "pending",
        priority: "low",
        children: [],
      },
    ]);

    expect(loadTodoForest("ses_a")).toEqual(TODO_TREE);
    expect(loadTodoForest("ses_b")).toEqual([
      {
        id: "solo",
        content: "Unrelated task",
        status: "pending",
        priority: "low",
        children: [],
      },
    ]);
  });

  it("builds a human-readable top-level summary plus full tree JSON", () => {
    expect(buildTodoTreeResult(TODO_TREE)).toEqual({
      title: "2 top-level todos",
      metadata: {
        topLevelCount: 2,
        totalCount: 5,
      },
      output: [
        "Top-level todos:",
        "- [~] Ship persistence layer (2 children)",
        "- [ ] Add MCP coverage",
        "",
        "Todo tree:",
        JSON.stringify(TODO_TREE, null, 2),
      ].join("\n"),
    });
  });

  it("builds a markdown tree for visible chat injection", () => {
    expect(buildMarkdownTodoTree(TODO_TREE)).toBe(
      [
        "# Todo Tree",
        "",
        "- [~] Ship persistence layer",
        "  - [x] Design schema",
        "  - [ ] Implement writes",
        "    - [ ] Add transaction wrapper",
        "- [ ] Add MCP coverage",
      ].join("\n"),
    );
  });

  it("appends a verification passphrase when explicitly enabled", () => {
    process.env.IMPROVED_TODO_VERIFICATION_PASSPHRASE = "SWORDFISH-TODO-TREE";

    expect(buildTodoTreeResult(TODO_TREE).output).toBe(
      [
        "Top-level todos:",
        "- [~] Ship persistence layer (2 children)",
        "- [ ] Add MCP coverage",
        "",
        "Todo tree:",
        JSON.stringify(TODO_TREE, null, 2),
        "",
        "Verification passphrase: SWORDFISH-TODO-TREE",
      ].join("\n"),
    );

    delete process.env.IMPROVED_TODO_VERIFICATION_PASSPHRASE;
  });
});

describe("ImprovedTodowritePlugin", () => {
  it("validates the tree schema", () => {
    expect(TodoTreeArgsSchema.parse({ todos: TODO_TREE })).toEqual({
      todos: TODO_TREE,
    });
  });

  it("writes a tree for the current session and reads it back", async () => {
    const { plugin, promptCalls } = await createPlugin();
    const calls: unknown[] = [];
    const writeResult = await plugin.tool!.improved_todowrite.execute(
      { todos: TODO_TREE },
      {
        sessionID: "ses_tree",
        messageID: "msg_write",
        agent: "Minimal",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata() {},
        async ask(input) {
          calls.push(input);
        },
      },
    );
    const readResult = await plugin.tool!.improved_todoread.execute(
      {},
      {
        sessionID: "ses_tree",
        messageID: "msg_read",
        agent: "Minimal",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata() {},
        async ask(input) {
          calls.push(input);
        },
      },
    );

    expect(writeResult).toBe(buildTodoTreeResult(TODO_TREE).output);
    expect(readResult).toBe(buildTodoTreeResult(TODO_TREE).output);
    expect(loadTodoForest("ses_tree")).toEqual(TODO_TREE);
    expect(calls).toEqual([
      {
        permission: "improved_todowrite",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
      },
      {
        permission: "improved_todoread",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
      },
    ]);
    expect(promptCalls).toEqual([
      {
        path: { id: "ses_tree" },
        body: {
          noReply: true,
          parts: [{ type: "text", text: buildMarkdownTodoTree(TODO_TREE) }],
        },
      },
      {
        path: { id: "ses_tree" },
        body: {
          noReply: true,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: buildTodoTreeReminder(),
            },
          ],
        },
      },
      {
        path: { id: "ses_tree" },
        body: {
          noReply: true,
          parts: [{ type: "text", text: buildMarkdownTodoTree(TODO_TREE) }],
        },
      },
      {
        path: { id: "ses_tree" },
        body: {
          noReply: true,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: buildTodoTreeReminder(),
            },
          ],
        },
      },
    ]);
  });
});
