import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TodoTreeNode, TodoTreeResult } from "./todo-tree.ts";

const CLI_TIMEOUT_MS = 60_000;
const CLI_REPOSITORY =
  "git+https://github.com/dzackgarza/opencode-plugin-improved-todowrite.git";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PYPROJECT_PATH = resolve(PACKAGE_ROOT, "pyproject.toml");

function cliInvocation(): { command: string; args: string[] } {
  if (existsSync(PYPROJECT_PATH)) {
    return {
      command: "uv",
      args: ["run", "--project", PACKAGE_ROOT, "improved-todowrite"],
    };
  }

  return {
    command: "uvx",
    args: ["--from", CLI_REPOSITORY, "improved-todowrite"],
  };
}

function parseTodoTreeResult(stdout: string, command: string): TodoTreeResult {
  const parsed = JSON.parse(stdout) as Partial<TodoTreeResult>;
  if (
    typeof parsed.title !== "string" ||
    typeof parsed.output !== "string" ||
    typeof parsed.metadata?.topLevelCount !== "number" ||
    typeof parsed.metadata?.totalCount !== "number" ||
    !Array.isArray(parsed.todos)
  ) {
    throw new Error(`improved-todowrite ${command} returned an unexpected JSON payload.`);
  }

  return parsed as TodoTreeResult;
}

function runTodoCli(
  command: "read" | "write",
  args: string[],
  stdinText?: string,
): Promise<TodoTreeResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const invocation = cliInvocation();
    const child = spawn(
      invocation.command,
      [...invocation.args, command, ...args, "--format", "json"],
      {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          UV_NO_PROGRESS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(
        new Error(`improved-todowrite ${command} timed out after ${CLI_TIMEOUT_MS}ms.`),
      );
    }, CLI_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timeout);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        rejectPromise(
          new Error(
            "The improved-todowrite adapters require `uv`/`uvx` on PATH. Install uv before using this plugin.",
          ),
        );
        return;
      }
      rejectPromise(error);
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(
          new Error(
            stderr.trim() ||
              stdout.trim() ||
              `improved-todowrite ${command} failed with exit code ${code}.`,
          ),
        );
        return;
      }

      try {
        resolvePromise(parseTodoTreeResult(stdout, command));
      } catch (error) {
        rejectPromise(
          error instanceof Error
            ? error
            : new Error(
                `improved-todowrite ${command} returned invalid JSON.\n${stdout.trim()}`,
              ),
        );
      }
    });

    if (stdinText) {
      child.stdin.end(stdinText);
      return;
    }

    child.stdin.end();
  });
}

export function writeTodoTree(
  sessionID: string,
  todos: TodoTreeNode[],
): Promise<TodoTreeResult> {
  return runTodoCli("write", [sessionID, "-"], JSON.stringify(todos));
}

export function readTodoTree(sessionID: string): Promise<TodoTreeResult> {
  return runTodoCli("read", [sessionID]);
}
