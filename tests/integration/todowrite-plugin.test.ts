import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  process.env.TODOWRITE_CLI_SPEC?.trim() || "git+https://github.com/dzackgarza/todowrite-manager.git";
const MAX_BUFFER = 8 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 240_000;
const AGENT_NAME = "plugin-proof";
const PROJECT_DIR = process.cwd();
const CLI_TOOL_DIR = mkdtempSync(join(tmpdir(), "todowrite-proof-cli-"));
let ocmBinaryPath: string | undefined;
let todowriteBinaryPath: string | undefined;

const VERIFICATION_PASSPHRASE = process.env.IMPROVED_TODOWRITE_TEST_PASSPHRASE?.trim();
if (!VERIFICATION_PASSPHRASE) throw new Error("IMPROVED_TODOWRITE_TEST_PASSPHRASE must be set");

type TranscriptTurn = {
  userPrompt: string;
};

type TranscriptData = {
  turns: TranscriptTurn[];
};

afterAll(() => {
  rmSync(CLI_TOOL_DIR, { recursive: true, force: true });
});

function ensureCliBinaries(): void {
  if (ocmBinaryPath && todowriteBinaryPath) return;
  const binDir = process.platform === "win32" ? join(CLI_TOOL_DIR, "Scripts") : join(CLI_TOOL_DIR, "bin");
  const candidateOcm = join(binDir, process.platform === "win32" ? "ocm.exe" : "ocm");
  const candidateTodowrite = join(binDir, process.platform === "win32" ? "todowrite.exe" : "todowrite");
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
  const result = spawnSync(
    getOcmBinaryPath(),
    args,
    {
      env: { ...process.env, OPENCODE_BASE_URL: BASE_URL },
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
    throw new Error(`ocm ${args.join(" ")} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  return { stdout, stderr };
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
    throw new Error(`todowrite run-json ${toolName} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
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

function readTranscript(sessionID: string): TranscriptData {
  const { stdout } = runOcm(["transcript", sessionID, "--json"]);
  return JSON.parse(stdout) as TranscriptData;
}

async function waitForPublishedPrompt(
  sessionID: string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = readTranscript(sessionID).turns
      .map((turn) => turn.userPrompt?.trim() ?? "")
      .find((text) => text.length > 0 && predicate(text));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for published todo tree prompt in session ${sessionID}.`);
}

type TodowriteResult = {
  current?: { id?: string };
  todos?: Array<{ id?: string }>;
};

function seedTodoTree(sessionID: string, input: { content: string; priority?: string }): TodowriteResult {
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
  it("proves todo_plan publishes the initial todo tree witness", async () => {
    const initialContent = `Initial ${randomUUID()}`;
    let sessionID: string | undefined;

    try {
      sessionID = createIdleProofSession();
      runOcm([
        "chat",
        sessionID,
        `Call todo_plan exactly once with todos=[{content:\"${initialContent}\",priority:\"high\",children:[]}]. Reply with ONLY READY.`,
      ]);
      const planPrompt = await waitForPublishedPrompt(
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
        try { runOcm(["delete", sessionID]); } catch { /* best-effort */ }
      }
    }
  }, SESSION_TIMEOUT_MS);

  it("proves todo_edit publishes updated content", async () => {
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
        `Call todo_edit exactly once with ops=[{type:\"update\",id:\"${id}\",content:\"${editedContent}\"}]. Reply with ONLY READY.`,
      ]);
      const editPrompt = await waitForPublishedPrompt(
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
        try { runOcm(["delete", sessionID]); } catch { /* best-effort */ }
      }
    }
  }, SESSION_TIMEOUT_MS);

  it("proves todo_advance publishes completed status", async () => {
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
        `Call todo_advance exactly once with id:\"${id}\" and action:\"complete\". Reply with ONLY READY.`,
      ]);
      const advancePrompt = await waitForPublishedPrompt(
        sessionID,
        (text) =>
          text.includes(editedContent) &&
          text.includes(`- [x] ${editedContent}`),
        SESSION_TIMEOUT_MS,
      );
      expect(advancePrompt).toContain(editedContent);
      expect(advancePrompt).toContain(`- [x] ${editedContent}`);
    } finally {
      if (sessionID) {
        try { runOcm(["delete", sessionID]); } catch { /* best-effort */ }
      }
    }
  }, SESSION_TIMEOUT_MS);

  it("proves todo_read publishes the current todo tree", async () => {
    const editedContent = `Edited ${randomUUID()}`;
    let sessionID: string | undefined;

    try {
      sessionID = createIdleProofSession();
      seedTodoTree(sessionID, { content: editedContent, priority: "high" });
      runOcm(["chat", sessionID, "Call todo_read exactly once. Reply with ONLY READY."]);
      const readPrompt = await waitForPublishedPrompt(
        sessionID,
        (text) =>
          text.includes(editedContent) &&
          text.includes(`- [ ] ${editedContent} <-- current`),
        SESSION_TIMEOUT_MS,
      );
      expect(readPrompt).toContain(editedContent);
      expect(readPrompt).toContain(`- [ ] ${editedContent} <-- current`);
    } finally {
      if (sessionID) {
        try { runOcm(["delete", sessionID]); } catch { /* best-effort */ }
      }
    }
  }, SESSION_TIMEOUT_MS);
});
