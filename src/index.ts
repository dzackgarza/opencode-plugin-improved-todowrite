import { type Plugin, tool } from '@opencode-ai/plugin';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 60_000;

async function runTodowrite(
  sessionID: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<any> {
  const cliGitRepo = 'git+file:///home/dzack/opencode-plugins/todowrite-manager';
  const { stdout } = await execFileAsync(
    'bunx',
    ['--from', cliGitRepo, 'todowrite', sessionID, toolName, JSON.stringify(args)],
    {
      timeout: CLI_TIMEOUT_MS,
    },
  );
  return JSON.parse(stdout);
}

export const ImprovedTodowritePlugin: Plugin = async ({ client }) => {
  async function publishTodoTree(sessionID: string, result: any) {
    if (!client.session?.prompt) return;

    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: result.markdown }],
      },
    });

    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: 'text', synthetic: true, text: result.reminder }],
      },
    });
  }

  function setDisplay(context: any, display: any): string {
    context.metadata({ title: display.title, metadata: display.metadata });
    return display.output;
  }

  return {
    tool: {
      todo_plan: tool({
        description: 'Create the initial hierarchical todo plan for this session.',
        args: {
          todos: tool.schema.array(tool.schema.any()).describe('Top-level tasks.'),
        },
        async execute(args, context) {
          await context.ask({
            permission: 'todo_plan',
            patterns: ['*'],
            always: ['*'],
            metadata: {},
          });
          const result = await runTodowrite(context.sessionID, 'todo_plan', args);
          await publishTodoTree(context.sessionID, result);
          return setDisplay(context, result.display);
        },
      }),

      todo_read: tool({
        description: 'Read the current todo tree for this session.',
        args: {},
        async execute(_args, context) {
          await context.ask({
            permission: 'todo_read',
            patterns: ['*'],
            always: ['*'],
            metadata: {},
          });
          const result = await runTodowrite(context.sessionID, 'todo_read', {});
          await publishTodoTree(context.sessionID, result);
          return setDisplay(context, result.display);
        },
      }),

      todo_advance: tool({
        description: 'Mark the current task as completed or cancelled.',
        args: {
          id: tool.schema.string().describe('ID of the current task'),
          action: tool.schema
            .enum(['complete', 'cancel'])
            .describe('complete or cancel'),
          reason: tool.schema.string().optional().describe('Required for cancel'),
        },
        async execute(args, context) {
          await context.ask({
            permission: 'todo_advance',
            patterns: ['*'],
            always: ['*'],
            metadata: {},
          });
          const result = await runTodowrite(context.sessionID, 'todo_advance', args);
          await publishTodoTree(context.sessionID, result);
          return setDisplay(context, result.display);
        },
      }),

      todo_edit: tool({
        description: 'Make surgical changes to the pending portions of the todo tree.',
        args: {
          ops: tool.schema.array(tool.schema.any()).describe('Edit operations'),
        },
        async execute(args, context) {
          await context.ask({
            permission: 'todo_edit',
            patterns: ['*'],
            always: ['*'],
            metadata: {},
          });
          const result = await runTodowrite(context.sessionID, 'todo_edit', args);
          await publishTodoTree(context.sessionID, result);
          return setDisplay(context, result.display);
        },
      }),
    },
  };
};
