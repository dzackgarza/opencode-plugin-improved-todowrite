import { afterAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// OpenCode must already be running before this file executes.
// `just test` runs the suite, but it does not start or stop the server.
const BASE_URL = process.env.OPENCODE_BASE_URL;
if (!BASE_URL) {
  throw new Error("OPENCODE_BASE_URL must be set (run against a repo-local or CI OpenCode server)");
}

const OCM_PACKAGE = "git+https://github.com/dzackgarza/opencode-manager.git";
const TODOWRITE_PACKAGE =
  process.env.TODOWRITE_CLI_SPEC?.trim() ||
  "git+https://github.com/dzackgarza/todowrite-manager.git";
const MAX_BUFFER = 8 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 240_000;
const TODO_READ_WITNESS_TIMEOUT_MS = 90_000;
const AGENT_NAME = "plugin-proof";
const PROJECT_DIR = process.cwd();
const CLI_TOOL_DIR = mkdtempSync(join(tmpdir(), "todowrite-proof-cli-"));
const REAL_TOOL_CALL_RULE =
  "Use the real OpenCode tool-call mechanism and start with the real tool call itself. Do not emit any visible preamble before the tool call. Plain text, JSON, or YAML that only describes a tool call does not count. Failure examples include functions.todo_read, EXECUTING functions.todo_edit ..., or recipient_name/functions.todo_* parameter blocks.";
const REAL_TOOL_CALL_READ_RULE =
  "Do not output code fences, pseudocode, or await functions.todo_read(...). Invoke the real todo_read tool with empty arguments instead.";
const PSEUDO_TOOL_CALL_PATTERN =
  /(?:^|\n)\s*EXECUTING(?:\s+functions\.todo_|\s*$)|(?:^|\n)\s*functions\.todo_(?:plan|read|advance|edit)\b|"(?:recipient_name|tool)"\s*:\s*"functions\.todo_/m;
let ocmBinaryPath: string | undefined;
let todowriteBinaryPath: string | undefined;

const VERIFICATION_PASSPHRASE = process.env.IMPROVED_TODOWRITE_TEST_PASSPHRASE?.trim();
if (!VERIFICATION_PASSPHRASE) throw new Error("IMPROVED_TODOWRITE_TEST_PASSPHRASE must be set");

type RawSessionMessage = {
  info?: {
    role?: string;
  };
  parts?: Array<{
    type?: string;
    text?: string;
    tool?: string;
    state?: {
      status?: string;
      output?: unknown;
      error?: unknown;
    };
  } | null>;
};

type RunningOcmProcess = {
  args: string[];
  child: ReturnType<typeof spawn>;
  completion: Promise<number | null>;
  readStdout: () => string;
  readStderr: () => string;
};

afterAll(() => {
  rmSync(CLI_TOOL_DIR, { recursive: true, force: true });
});

function ensureCliBinaries(): void {
  if (ocmBinaryPath && todowriteBinaryPath) return;
  const binDir =
    process.platform === "win32" ? join(CLI_TOOL_DIR, "Scripts") : join(CLI_TOOL_DIR, "bin");
  const candidateOcm = join(binDir, process.platform === "win32" ? "ocm.exe" : "ocm");
  const candidateTodowrite = join(
    binDir,
    process.platform === "win32" ? "todowrite.exe" : "todowrite",
  );
  const pythonBinary = join(binDir, process.platform === "win32" ? "python.exe" : "python");
  if (!existsSync(candidateOcm) || !existsSync(candidateTodowrite)) {
    const createVenv = spawnSync("uv", ["venv", CLI_TOOL_DIR], {
      env: process.env,
      cwd: PROJECT_DIR,
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    if (createVenv.error) throw createVenv.error;
    if (createVenv.status !== 0) {
      throw new Error(
        `Failed to create proof CLI venv\nSTDOUT:\n${createVenv.stdout ?? ""}\nSTDERR:\n${createVenv.stderr ?? ""}`,
      );
    }
    const install = spawnSync(
      "uv",
      ["pip", "install", "--python", pythonBinary, OCM_PACKAGE, TODOWRITE_PACKAGE],
      {
        env: process.env,
        cwd: PROJECT_DIR,
        encoding: "utf8",
        timeout: SESSION_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
    );
    if (install.error) throw install.error;
    if (install.status !== 0 || !existsSync(candidateOcm) || !existsSync(candidateTodowrite)) {
      throw new Error(
        `Failed to install proof CLIs\nSTDOUT:\n${install.stdout ?? ""}\nSTDERR:\n${install.stderr ?? ""}`,
      );
    }
  }
  ocmBinaryPath = candidateOcm;
  todowriteBinaryPath = candidateTodowrite;
}

function getOcmBinaryPath(): string {
  ensureCliBinaries();
  if (!ocmBinaryPath) throw new Error("ocm binary was not installed");
  return ocmBinaryPath;
}

function getTodowriteBinaryPath(): string {
  ensureCliBinaries();
  if (!todowriteBinaryPath) throw new Error("todowrite binary was not installed");
  return todowriteBinaryPath;
}

function runOcm(args: string[]) {
  const result = spawnSync(getOcmBinaryPath(), args, {
    env: { ...process.env, OPENCODE_BASE_URL: BASE_URL },
    cwd: PROJECT_DIR,
    encoding: "utf8",
    timeout: SESSION_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    throw new Error(`ocm ${args.join(" ")} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  return { stdout, stderr };
}

function startOcm(args: string[]): RunningOcmProcess {
  const child = spawn(getOcmBinaryPath(), args, {
    env: { ...process.env, OPENCODE_BASE_URL: BASE_URL },
    cwd: PROJECT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  return {
    args,
    child,
    completion,
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOcmProcess(
  process: RunningOcmProcess,
  timeoutMs: number,
): Promise<{
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  killedForCleanup: boolean;
}> {
  let timedOut = false;
  const result = await Promise.race([
    process.completion.then((code) => ({ code, timedOut: false })),
    sleep(timeoutMs).then(() => {
      timedOut = true;
      return { code: process.child.exitCode, timedOut: true };
    }),
  ]);
  return {
    code: result.code,
    timedOut: timedOut || result.timedOut,
    stdout: process.readStdout(),
    stderr: process.readStderr(),
    killedForCleanup: false,
  };
}

async function stopOcmProcess(process: RunningOcmProcess): Promise<{
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  killedForCleanup: boolean;
}> {
  let result = await waitForOcmProcess(process, 2_000);
  if (!result.timedOut) return result;
  process.child.kill("SIGTERM");
  result = await waitForOcmProcess(process, 1_000);
  if (!result.timedOut) return { ...result, killedForCleanup: true };
  process.child.kill("SIGKILL");
  return { ...(await waitForOcmProcess(process, 1_000)), killedForCleanup: true };
}

function formatOcmProcessOutcome(
  args: string[],
  outcome: {
    code: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    killedForCleanup: boolean;
  },
): string {
  const prefix = outcome.timedOut
    ? `ocm ${args.join(" ")} did not exit before cleanup`
    : outcome.killedForCleanup
      ? `ocm ${args.join(" ")} was terminated during cleanup`
      : `ocm ${args.join(" ")} exited with code ${outcome.code}`;
  return `${prefix}\nSTDOUT:\n${outcome.stdout}\nSTDERR:\n${outcome.stderr}`;
}

function runTodowriteJson(sessionID: string, toolName: string, payload: Record<string, unknown>) {
  const result = spawnSync(
    getTodowriteBinaryPath(),
    ["run-json", toolName, sessionID, JSON.stringify(payload)],
    {
      env: process.env,
      cwd: PROJECT_DIR,
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    throw new Error(
      `todowrite run-json ${toolName} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  return JSON.parse(stdout) as { markdown?: string };
}

function beginSession(prompt: string): string {
  const { stdout } = runOcm(["begin-session", prompt, "--agent", AGENT_NAME, "--json"]);
  const data = JSON.parse(stdout) as { sessionID: string };
  if (!data.sessionID) throw new Error(`begin-session returned no sessionID: ${stdout}`);
  return data.sessionID;
}

function waitIdle(sessionID: string): void {
  runOcm(["wait", sessionID, "--timeout-sec=180"]);
}

function createIdleProofSession(): string {
  const sessionID = beginSession("Reply with ONLY READY.");
  waitIdle(sessionID);
  return sessionID;
}

async function readRawSessionMessages(sessionID: string): Promise<RawSessionMessage[]> {
  const response = await fetch(`${BASE_URL}/session/${sessionID}/message`);
  if (!response.ok) {
    throw new Error(`Failed to load session messages for ${sessionID}: ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(`Session messages for ${sessionID} were not an array.`);
  }
  return data as RawSessionMessage[];
}

function flattenMessageText(message: RawSessionMessage): string {
  return (message.parts ?? [])
    .filter(
      (part): part is { type?: string; text?: string } => part !== null && typeof part === "object",
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

function truncateDiagnosticText(value: string, maxLength = 240): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function formatMessageDiagnostics(message: RawSessionMessage): string {
  return (message.parts ?? [])
    .filter(
      (
        part,
      ): part is {
        type?: string;
        text?: string;
        tool?: string;
        state?: { status?: string; output?: unknown; error?: unknown };
      } => part !== null && typeof part === "object",
    )
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        const text = part.text.trim();
        return text.length > 0 ? text : "";
      }
      if (part.type !== "tool") return "";
      const fragments = [`tool:${part.tool ?? "unknown"}`];
      if (typeof part.state?.status === "string") {
        fragments.push(`status=${part.state.status}`);
      }
      if (part.state?.output !== undefined) {
        const output =
          typeof part.state.output === "string"
            ? part.state.output
            : JSON.stringify(part.state.output);
        if (output) fragments.push(`output=${truncateDiagnosticText(output)}`);
      }
      if (part.state?.error !== undefined) {
        const error =
          typeof part.state.error === "string"
            ? part.state.error
            : JSON.stringify(part.state.error);
        if (error) fragments.push(`error=${truncateDiagnosticText(error)}`);
      }
      return fragments.join(" ");
    })
    .filter(Boolean)
    .join(" | ");
}

function formatRecentSessionMessages(messages: RawSessionMessage[]): string {
  return messages
    .slice(-12)
    .map((message) => `${message.info?.role ?? "unknown"} :: ${formatMessageDiagnostics(message)}`)
    .join("\n");
}

function findPseudoToolCallText(messages: RawSessionMessage[]): string | null {
  return (
    messages
      .filter((message) => message.info?.role === "assistant")
      .map(flattenMessageText)
      .find((text) => text.length > 0 && PSEUDO_TOOL_CALL_PATTERN.test(text)) ?? null
  );
}

async function waitForPublishedMessageText(
  sessionID: string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let recentMessages: RawSessionMessage[] = [];
  while (Date.now() < deadline) {
    recentMessages = await readRawSessionMessages(sessionID);
    const pseudoToolCall = findPseudoToolCallText(recentMessages);
    if (pseudoToolCall) {
      throw new Error(
        `Assistant emitted a faux tool call instead of a real OpenCode tool invocation in session ${sessionID}.\n` +
          `Assistant text:\n${pseudoToolCall}\nRecent messages:\n${formatRecentSessionMessages(recentMessages)}`,
      );
    }
    const match = recentMessages
      .filter((message) => message.info?.role !== "assistant")
      .map(flattenMessageText)
      .find((text) => text.length > 0 && predicate(text));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for published todo tree message in session ${sessionID}.\nRecent messages:\n${formatRecentSessionMessages(recentMessages)}`,
  );
}

type TodowriteResult = {
  current?: { id?: string };
  todos?: Array<{ id?: string }>;
};

function seedTodoTree(
  sessionID: string,
  input: { content: string; priority?: string },
): TodowriteResult {
  return runTodowriteJson(sessionID, "todo-plan", {
    todos: [
      {
        content: input.content,
        ...(input.priority ? { priority: input.priority } : {}),
        children: [],
      },
    ],
  }) as TodowriteResult;
}

describe("improved-todowrite live e2e", () => {
  it(
    "proves todo_plan publishes the initial todo tree witness",
    async () => {
      const initialContent = `Initial ${randomUUID()}`;
      let sessionID: string | undefined;

      try {
        sessionID = createIdleProofSession();
        runOcm([
          "chat",
          sessionID,
          `Call todo_plan exactly once with this exact JSON arguments object: {"todos":[{"content":"${initialContent}","priority":"high","children":[]}]}. ${REAL_TOOL_CALL_RULE} Reply with ONLY READY.`,
        ]);
        const planPrompt = await waitForPublishedMessageText(
          sessionID,
          (text) =>
            text.includes("# Todo Tree") &&
            text.includes(initialContent) &&
            text.includes(`- [ ] ${initialContent} <-- current`),
          SESSION_TIMEOUT_MS,
        );
        expect(planPrompt).toContain(initialContent);
        expect(planPrompt).toContain(`- [ ] ${initialContent} <-- current`);
      } finally {
        if (sessionID) {
          try {
            runOcm(["delete", sessionID]);
          } catch {
            /* best-effort */
          }
        }
      }
    },
    SESSION_TIMEOUT_MS,
  );

  it(
    "proves todo_edit publishes updated content",
    async () => {
      const initialContent = `Initial ${randomUUID()}`;
      const editedContent = `Edited ${randomUUID()}`;
      let sessionID: string | undefined;

      try {
        sessionID = createIdleProofSession();
        const seeded = seedTodoTree(sessionID, { content: initialContent, priority: "high" });
        const id = seeded.current?.id ?? seeded.todos?.[0]?.id;
        if (!id) throw new Error("todo-plan did not return a current or top-level todo id");
        runOcm([
          "chat",
          sessionID,
          `Call todo_edit exactly once with this exact JSON arguments object: {"ops":[{"type":"update","id":"${id}","content":"${editedContent}"}]}. ${REAL_TOOL_CALL_RULE} Reply with ONLY READY.`,
        ]);
        const editPrompt = await waitForPublishedMessageText(
          sessionID,
          (text) =>
            text.includes("# Todo Tree") &&
            text.includes(editedContent) &&
            text.includes(`- [ ] ${editedContent} <-- current`),
          SESSION_TIMEOUT_MS,
        );
        expect(editPrompt).toContain(editedContent);
        expect(editPrompt).toContain(`- [ ] ${editedContent} <-- current`);
      } finally {
        if (sessionID) {
          try {
            runOcm(["delete", sessionID]);
          } catch {
            /* best-effort */
          }
        }
      }
    },
    SESSION_TIMEOUT_MS,
  );

  it(
    "proves todo_advance publishes completed status",
    async () => {
      const editedContent = `Edited ${randomUUID()}`;
      let sessionID: string | undefined;

      try {
        sessionID = createIdleProofSession();
        const seeded = seedTodoTree(sessionID, { content: editedContent, priority: "high" });
        const id = seeded.current?.id ?? seeded.todos?.[0]?.id;
        if (!id) throw new Error("todo-plan did not return a current or top-level todo id");
        runOcm([
          "chat",
          sessionID,
          `Call todo_advance exactly once with this exact JSON arguments object: {"id":"${id}","action":"complete"}. ${REAL_TOOL_CALL_RULE} Reply with ONLY READY.`,
        ]);
        const advancePrompt = await waitForPublishedMessageText(
          sessionID,
          (text) => text.includes(editedContent) && text.includes(`- [x] ${editedContent}`),
          SESSION_TIMEOUT_MS,
        );
        expect(advancePrompt).toContain(editedContent);
        expect(advancePrompt).toContain(`- [x] ${editedContent}`);
      } finally {
        if (sessionID) {
          try {
            runOcm(["delete", sessionID]);
          } catch {
            /* best-effort */
          }
        }
      }
    },
    SESSION_TIMEOUT_MS,
  );

  it(
    "proves todo_read publishes the current todo tree",
    async () => {
      const editedContent = `Edited ${randomUUID()}`;
      let sessionID: string | undefined;

      try {
        sessionID = createIdleProofSession();
        seedTodoTree(sessionID, { content: editedContent, priority: "high" });
        const readArgs = [
          "chat",
          sessionID,
          `Call todo_read exactly once with this exact JSON arguments object: {}. ${REAL_TOOL_CALL_RULE} ${REAL_TOOL_CALL_READ_RULE} Reply with ONLY READY.`,
        ];
        const readProcess = startOcm(readArgs);
        let readPrompt: string;
        try {
          readPrompt = await waitForPublishedMessageText(
            sessionID,
            (text) =>
              text.includes("# Todo Tree") &&
              text.includes(editedContent) &&
              text.includes(`- [ ] ${editedContent} <-- current`),
            TODO_READ_WITNESS_TIMEOUT_MS,
          );
        } catch (error) {
          const outcome = await stopOcmProcess(readProcess);
          const details = formatOcmProcessOutcome(readArgs, outcome);
          throw new Error(`${error instanceof Error ? error.message : String(error)}\n${details}`);
        }
        waitIdle(sessionID);
        const outcome = await stopOcmProcess(readProcess);
        if (!outcome.timedOut && !outcome.killedForCleanup && outcome.code !== 0) {
          throw new Error(formatOcmProcessOutcome(readArgs, outcome));
        }
        expect(readPrompt).toContain(editedContent);
        expect(readPrompt).toContain(`- [ ] ${editedContent} <-- current`);
      } finally {
        if (sessionID) {
          try {
            runOcm(["delete", sessionID]);
          } catch {
            /* best-effort */
          }
        }
      }
    },
    SESSION_TIMEOUT_MS,
  );
});
