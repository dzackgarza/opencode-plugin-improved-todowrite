import { type Plugin, tool } from "@opencode-ai/plugin";
import {
  buildMarkdownTodoTree,
  buildTodoTreeReminder,
  IMPROVED_TODOREAD_DESCRIPTION,
  IMPROVED_TODOWRITE_DESCRIPTION,
  TodoTreeNodeSchema,
} from "./todo-tree.ts";
import { readTodoTree, writeTodoTree } from "./cli-adapter.ts";
import pkg from "../package.json" assert { type: "json" };

const PLUGIN_VERSION = pkg.version;

function withPluginVersion(description: string): string {
  return `${description} (Plugin version: ${PLUGIN_VERSION})`;
}

export const ImprovedTodowritePlugin: Plugin = async ({ client }) => {
  async function publishTodoTree(
    sessionID: string,
    todos: Parameters<typeof buildMarkdownTodoTree>[0],
  ) {
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

  function setToolDisplayMetadata(
    context: {
      metadata(input: {
        title?: string;
        metadata?: Record<string, unknown>;
      }): void;
    },
    result: {
      title: string;
      metadata: Record<string, unknown>;
      output: string;
    },
  ): string {
    context.metadata({
      title: result.title,
      metadata: result.metadata,
    });
    return result.output;
  }

  return {
    tool: {
      improved_todowrite: tool({
        description: withPluginVersion(IMPROVED_TODOWRITE_DESCRIPTION),
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
          const result = await writeTodoTree(context.sessionID, args.todos);
          await publishTodoTree(context.sessionID, result.todos);
          return setToolDisplayMetadata(context, result);
        },
      }),
      improved_todoread: tool({
        description: withPluginVersion(IMPROVED_TODOREAD_DESCRIPTION),
        args: {},
        async execute(_args, context) {
          await context.ask({
            permission: "improved_todoread",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          });
          const result = await readTodoTree(context.sessionID);
          await publishTodoTree(context.sessionID, result.todos);
          return setToolDisplayMetadata(context, result);
        },
      }),
    },
  };
};
