import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildMarkdownTodoTree,
  buildTodoTreeReminder,
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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "improved-todo-test-"));
  process.env.IMPROVED_TODO_SQLITE_PATH = join(tempDir, "todos.sqlite");
  process.env.IMPROVED_TODO_VERIFICATION_PASSPHRASE = "SWORDFISH-TODO-TREE";
});

afterEach(async () => {
  delete process.env.IMPROVED_TODO_SQLITE_PATH;
  delete process.env.IMPROVED_TODO_VERIFICATION_PASSPHRASE;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDir = "";
});

describe("todo tree presentation", () => {
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

  it("builds the reminder after publishing the full tree", () => {
    expect(buildTodoTreeReminder()).toBe(
      [
        "<system-reminder>",
        "The full todo tree has already been displayed in chat.",
        "Refer to that displayed tree instead of repeating the full hierarchy unless the user asks for it again.",
        "</system-reminder>",
      ].join("\n"),
    );
  });
});

describe("ImprovedTodowritePlugin", () => {
  it("delegates write and read calls through the standalone CLI", async () => {
    const { plugin, promptCalls } = await createPlugin();
    const permissionCalls: unknown[] = [];
    const writeMetadata: unknown[] = [];
    const readMetadata: unknown[] = [];

    const writeResult = await plugin.tool!.improved_todowrite.execute(
      { todos: TODO_TREE },
      {
        sessionID: "ses_tree",
        messageID: "msg_write",
        agent: "plugin-proof",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata(input) {
          writeMetadata.push(input);
        },
        async ask(input) {
          permissionCalls.push(input);
        },
      },
    );

    const readResult = await plugin.tool!.improved_todoread.execute(
      {},
      {
        sessionID: "ses_tree",
        messageID: "msg_read",
        agent: "plugin-proof",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata(input) {
          readMetadata.push(input);
        },
        async ask(input) {
          permissionCalls.push(input);
        },
      },
    );

    const expectedOutput = [
      "Top-level todos:",
      "- [~] Ship persistence layer (2 children)",
      "- [ ] Add MCP coverage",
      "",
      "Todo tree:",
      JSON.stringify(TODO_TREE, null, 2),
      "",
      "Verification passphrase: SWORDFISH-TODO-TREE",
    ].join("\n");

    expect(writeResult).toBe(expectedOutput);
    expect(readResult).toBe(expectedOutput);
    expect(permissionCalls).toHaveLength(2);
    expect(writeMetadata).toEqual([
      {
        title: "2 top-level todos",
        metadata: {
          topLevelCount: 2,
          totalCount: 5,
        },
      },
    ]);
    expect(readMetadata).toEqual(writeMetadata);
    expect(
      promptCalls.map(
        (call) =>
          (call as { body: { parts: Array<{ text: string }> } }).body.parts[0].text,
      ),
    ).toEqual([
      buildMarkdownTodoTree(TODO_TREE),
      buildTodoTreeReminder(),
      buildMarkdownTodoTree(TODO_TREE),
      buildTodoTreeReminder(),
    ]);
  });
});
