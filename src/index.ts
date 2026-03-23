import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Plugin, tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 60_000;
const CLI_SPEC =
  process.env.TODOWRITE_CLI_SPEC ?? "git+https://github.com/dzackgarza/todowrite-manager.git";

function runTodowrite(
  sessionID: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return execFileAsync(
    "uvx",
    ["--from", CLI_SPEC, "todowrite", "run-json", toolName, sessionID, JSON.stringify(args)],
    { timeout: CLI_TIMEOUT_MS },
  ).then((r: { stdout: string }) => {
    try {
      return JSON.parse(r.stdout) as unknown;
    } catch {
      return r.stdout as unknown;
    }
  });
}

type TodoResult = {
  markdown: string;
  reminder: string;
  display: { title: string; metadata: Record<string, unknown>; output: string };
};

type MetadataFn = (opts: { title: string; metadata: Record<string, unknown> }) => void;

function setDisplay(setMeta: MetadataFn, display: TodoResult["display"]): string {
  setMeta({ title: display.title, metadata: display.metadata });
  return display.output;
}

export const ImprovedTodowritePlugin: Plugin = ({ client }) => {
  function publishTodoTree(sessionID: string, result: TodoResult): Promise<unknown> {
    const promptFn = client.session?.prompt;
    if (promptFn === undefined) return Promise.resolve("skipped" as const);
    return promptFn({
      path: { id: sessionID },
      body: { noReply: true, parts: [{ type: "text", text: result.markdown }] },
    }).then(() =>
      promptFn({
        path: { id: sessionID },
        body: { noReply: true, parts: [{ type: "text", synthetic: true, text: result.reminder }] },
      }),
    );
  }

  function runAndPublish(
    sessionID: string,
    toolName: string,
    args: Record<string, unknown>,
    setMeta: MetadataFn,
  ): Promise<string> {
    return runTodowrite(sessionID, toolName, args).then((raw) => {
      const result = raw as TodoResult;
      return publishTodoTree(sessionID, result).then(() => setDisplay(setMeta, result.display));
    });
  }

  return Promise.resolve({
    tool: {
      todo_plan: tool({
        description: "Create the initial hierarchical todo plan for this session.",
        args: {
          todos: tool.schema.array(tool.schema.unknown()).describe("Top-level tasks."),
        },
        execute(args: { todos: unknown[] }, context) {
          return context
            .ask({ permission: "todo_plan", patterns: ["*"], always: ["*"], metadata: {} })
            .then(() =>
              runAndPublish(context.sessionID, "todo-plan", args, (opts) => context.metadata(opts)),
            );
        },
      }),

      todo_read: tool({
        description: "Read the current todo tree for this session.",
        args: {},
        execute(_args: Record<string, never>, context) {
          return context
            .ask({ permission: "todo_read", patterns: ["*"], always: ["*"], metadata: {} })
            .then(() =>
              runAndPublish(context.sessionID, "todo-read", {}, (opts) => context.metadata(opts)),
            );
        },
      }),

      todo_advance: tool({
        description: "Mark the current task as completed or cancelled.",
        args: {
          id: tool.schema.string().describe("ID of the current task"),
          action: tool.schema.enum(["complete", "cancel"]).describe("complete or cancel"),
          reason: tool.schema.string().optional().describe("Required for cancel"),
        },
        execute(args: { id: string; action: "complete" | "cancel"; reason?: string }, context) {
          return context
            .ask({ permission: "todo_advance", patterns: ["*"], always: ["*"], metadata: {} })
            .then(() =>
              runAndPublish(context.sessionID, "todo-advance", args, (opts) =>
                context.metadata(opts),
              ),
            );
        },
      }),

      todo_edit: tool({
        description: "Make surgical changes to the pending portions of the todo tree.",
        args: {
          ops: tool.schema.array(tool.schema.unknown()).describe("Edit operations"),
        },
        execute(args: { ops: unknown[] }, context) {
          return context
            .ask({ permission: "todo_edit", patterns: ["*"], always: ["*"], metadata: {} })
            .then(() =>
              runAndPublish(context.sessionID, "todo-edit", args, (opts) => context.metadata(opts)),
            );
        },
      }),
    },
  });
};
