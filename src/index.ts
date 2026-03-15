import { type Plugin, tool } from "@opencode-ai/plugin";
import {
  advanceTodo,
  buildMarkdownTodoTree,
  buildTodoTreeReminder,
  createPlan,
  EditOpSchema,
  editTodos,
  getCurrentTask,
  loadTodoForest,
  PlanInputSchema,
  setToolDisplayMetadata,
} from "./todo-tree.ts";
import pkg from "../package.json" assert { type: "json" };

const PLUGIN_VERSION = pkg.version;

function v(description: string): string {
  return `${description} (Plugin version: ${PLUGIN_VERSION})`;
}

export const ImprovedTodowritePlugin: Plugin = async ({ client }) => {
  async function publishTodoTree(
    sessionID: string,
    todos: Parameters<typeof buildMarkdownTodoTree>[0],
    current: Parameters<typeof buildMarkdownTodoTree>[1],
  ) {
    if (!client.session?.prompt) return;

    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text: buildMarkdownTodoTree(todos, current) }],
      },
    });

    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", synthetic: true, text: buildTodoTreeReminder() }],
      },
    });
  }

  return {
    tool: {
      todo_plan: tool({
        description: v(
          "Create the initial hierarchical todo plan for this session. " +
            "Call this once at the start of any multi-step task. " +
            "Blocked if a plan already exists — use todo_edit for surgical changes. " +
            "Break work into phases and subtasks; the order you list them is the order they must be completed.",
        ),
        args: {
          todos: tool.schema
            .array(PlanInputSchema)
            .describe("Top-level tasks. Each may contain nested subtasks."),
        },
        async execute(args, context) {
          await context.ask({
            permission: "todo_plan",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          });
          const nodes = createPlan(context.sessionID, args.todos);
          const current = getCurrentTask(nodes);
          await publishTodoTree(context.sessionID, nodes, current);
          return setToolDisplayMetadata(context, nodes, current);
        },
      }),

      todo_read: tool({
        description: v(
          "Read the current todo tree for this session, including which task is active. " +
            "Call this to recover task IDs before using todo_advance or todo_edit.",
        ),
        args: {},
        async execute(_args, context) {
          await context.ask({
            permission: "todo_read",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          });
          const nodes = loadTodoForest(context.sessionID);
          const current = getCurrentTask(nodes);
          await publishTodoTree(context.sessionID, nodes, current);
          return setToolDisplayMetadata(context, nodes, current);
        },
      }),

      todo_advance: tool({
        description: v(
          "Mark the current task as completed or cancelled. " +
            "You MUST supply the exact ID of the current task (from todo_read or a prior tool result) — " +
            "this proves you know what you are claiming to have finished. " +
            "Tasks must be completed in order; you cannot skip ahead. " +
            "Cancellation requires a documented reason.",
        ),
        args: {
          id: tool.schema
            .string()
            .describe("ID of the current task, exactly as shown in the tree"),
          action: tool.schema
            .enum(["complete", "cancel"])
            .describe("complete — mark done; cancel — mark cancelled with a reason"),
          reason: tool.schema
            .string()
            .optional()
            .describe("Required when action is cancel. Explain why this task is being dropped."),
        },
        async execute(args, context) {
          await context.ask({
            permission: "todo_advance",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          });
          const { updated, next } = advanceTodo(
            context.sessionID,
            args.id,
            args.action,
            args.reason,
          );
          await publishTodoTree(context.sessionID, updated, next);
          return setToolDisplayMetadata(context, updated, next);
        },
      }),

      todo_edit: tool({
        description: v(
          "Make surgical changes to the pending portions of the todo tree: " +
            "add new tasks, update content or priority of pending tasks, or cancel pending tasks with a reason. " +
            "Does NOT change the status of tasks — use todo_advance for that. " +
            "Completed and cancelled nodes are immutable history and cannot be edited or deleted. " +
            "Use this for replanning, not for wholesale rewrites.",
        ),
        args: {
          ops: tool.schema
            .array(EditOpSchema)
            .describe(
              "Ordered list of edit operations. " +
                "add: insert a new pending task. " +
                "update: change content or priority of a pending task by ID. " +
                "cancel: cancel a pending task with a required reason.",
            ),
        },
        async execute(args, context) {
          await context.ask({
            permission: "todo_edit",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          });
          const updated = editTodos(context.sessionID, args.ops);
          const current = getCurrentTask(updated);
          await publishTodoTree(context.sessionID, updated, current);
          return setToolDisplayMetadata(context, updated, current);
        },
      }),
    },
  };
};
