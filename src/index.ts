import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Plugin, type PluginInput, type ToolContext, tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 60_000;
const CLI_SPEC =
  process.env.TODOWRITE_CLI_SPEC ?? "git+https://github.com/dzackgarza/todowrite-manager.git";

function runTodowrite(sessionID: string, toolName: string, args: Record<string, unknown>) {
  return execFileAsync(
    "uvx",
    ["--from", CLI_SPEC, "todowrite", "run-json", toolName, sessionID, JSON.stringify(args)],
    { timeout: CLI_TIMEOUT_MS },
  ).then(({ stdout }) => {
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      return stdout as unknown;
    }
  });
}

type TodoResult = {
  markdown: string;
  reminder: string;
  display: { title: string; metadata: Record<string, unknown>; output: string };
};

function setDisplay(context: ToolContext, display: TodoResult["display"]): string {
  context.metadata({ title: display.title, metadata: display.metadata });
  return display.output;
}

export const ImprovedTodowritePlugin: Plugin = async ({ client }: PluginInput) => {
  function publishTodoTree(sessionID: string, result: TodoResult) {
    const promptFn = client.session?.prompt;
    if (!promptFn) return "skipped" as const;
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

  return {
    tool: {
      todo_plan: tool({
        description: "Create the initial hierarchical todo plan for this session.",
        args: {
          todos: tool.schema.array(tool.schema.unknown()).describe("Top-level tasks."),
        },
        async execute(args: { todos: unknown[] }, context: ToolContext) {
          await context.ask({
            permission: "todo_plan",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          });
          const result = (await runTodowrite(context.sessionID, "todo-plan", args)) as TodoResult;
          await publishTodoTree(context.sessionID, result);
          return setDisplay(context, result.display);
        },
      }),

      todo_read: tool({
        description: "Read the current todo tree for this session.",
        args: {},
        async execute(_args: Record<string, never>, context: ToolContext) {
          await context.ask({
            permission: "todo_read",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          });
          const result = (await runTodowrite(context.sessionID, "todo-read", {})) as TodoResult;
          await publishTodoTree(context.sessionID, result);
          return setDisplay(context, result.display);
        },
      }),

      todo_advance: tool({
        description: "Mark the current task as completed or cancelled.",
        args: {
          id: tool.schema.string().describe("ID of the current task"),
          action: tool.schema.enum(["complete", "cancel"]).describe("complete or cancel"),
          reason: tool.schema.string().optional().describe("Required for cancel"),
        },
        async execute(
          args: { id: string; action: "complete" | "cancel"; reason?: string },
          context: ToolContext,
        ) {
          await context.ask({
            permission: "todo_advance",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          });
          const result = (await runTodowrite(
            context.sessionID,
            "todo-advance",
            args,
          )) as TodoResult;
          await publishTodoTree(context.sessionID, result);
          return setDisplay(context, result.display);
        },
      }),

      todo_edit: tool({
        description: "Make surgical changes to the pending portions of the todo tree.",
        args: {
          ops: tool.schema.array(tool.schema.unknown()).describe("Edit operations"),
        },
        async execute(args: { ops: unknown[] }, context: ToolContext) {
          await context.ask({
            permission: "todo_edit",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          });
          const result = (await runTodowrite(context.sessionID, "todo-edit", args)) as TodoResult;
          await publishTodoTree(context.sessionID, result);
          return setDisplay(context, result.display);
        },
      }),
    },
  };
};
