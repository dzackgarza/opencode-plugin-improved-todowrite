import { type Plugin, tool } from "@opencode-ai/plugin";
import {
  buildMarkdownTodoTree,
  buildTodoTreeReminder,
  IMPROVED_TODOREAD_DESCRIPTION,
  IMPROVED_TODOWRITE_DESCRIPTION,
  loadTodoForest,
  setToolDisplayMetadata,
  storeTodoForest,
  TodoTreeNodeSchema,
} from "./todo-tree.ts";

export const ImprovedTodowritePlugin: Plugin = async ({ client }) => {
  async function publishTodoTree(sessionID: string, todos: Parameters<typeof buildMarkdownTodoTree>[0]) {
    if (!client.session?.prompt) return;

    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [
          {
            type: "text",
            text: buildMarkdownTodoTree(todos),
          },
        ],
      },
    });

    await client.session.prompt({
      path: { id: sessionID },
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
    });
  }

  return {
    tool: {
      improved_todowrite: tool({
        description: IMPROVED_TODOWRITE_DESCRIPTION,
        args: {
          todos: tool.schema.array(TodoTreeNodeSchema),
        },
        async execute(args, context) {
          await context.ask({
            permission: "improved_todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          });
          storeTodoForest(context.sessionID, args.todos);
          await publishTodoTree(context.sessionID, args.todos);
          return setToolDisplayMetadata(context, args.todos);
        },
      }),
      improved_todoread: tool({
        description: IMPROVED_TODOREAD_DESCRIPTION,
        args: {},
        async execute(_args, context) {
          await context.ask({
            permission: "improved_todoread",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          });
          const todos = loadTodoForest(context.sessionID);
          await publishTodoTree(context.sessionID, todos);
          return setToolDisplayMetadata(context, todos);
        },
      }),
    },
  };
};
