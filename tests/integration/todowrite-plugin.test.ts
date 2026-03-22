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

const MANAGER_PACKAGE = "git+https://github.com/dzackgarza/opencode-manager.git";
const MAX_BUFFER = 8 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 240_000;
const AGENT_NAME = "plugin-proof";
const PROJECT_DIR = process.cwd();
const OCM_TOOL_DIR = mkdtempSync(join(tmpdir(), "ocm-tool-"));
let ocmBinaryPath: string | undefined;

const VERIFICATION_PASSPHRASE = process.env.IMPROVED_TODOWRITE_TEST_PASSPHRASE?.trim();
if (!VERIFICATION_PASSPHRASE) throw new Error("IMPROVED_TODOWRITE_TEST_PASSPHRASE must be set");

type TranscriptData = {
  turns: Array<{
    userPrompt: string;
  }>;
};

afterAll(() => {
  rmSync(OCM_TOOL_DIR, { recursive: true, force: true });
});

function getOcmBinaryPath(): string {
  if (ocmBinaryPath) return ocmBinaryPath;
  const binDir = process.platform === "win32" ? join(OCM_TOOL_DIR, "Scripts") : join(OCM_TOOL_DIR, "bin");
  const candidate = join(binDir, process.platform === "win32" ? "ocm.exe" : "ocm");
  const pythonBinary = join(binDir, process.platform === "win32" ? "python.exe" : "python");
  if (!existsSync(candidate)) {
    const createVenv = spawnSync("uv", ["venv", OCM_TOOL_DIR], {
      env: process.env,
      cwd: PROJECT_DIR,
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    if (createVenv.error) throw createVenv.error;
    if (createVenv.status !== 0) {
      throw new Error(
        `Failed to create ocm venv\nSTDOUT:\n${createVenv.stdout ?? ""}\nSTDERR:\n${createVenv.stderr ?? ""}`,
      );
    }
    const install = spawnSync(
      "uv",
      ["pip", "install", "--python", pythonBinary, MANAGER_PACKAGE],
      {
        env: process.env,
        cwd: PROJECT_DIR,
        encoding: "utf8",
        timeout: SESSION_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
    );
    if (install.error) throw install.error;
    if (install.status !== 0 || !existsSync(candidate)) {
      throw new Error(
        `Failed to install ocm\nSTDOUT:\n${install.stdout ?? ""}\nSTDERR:\n${install.stderr ?? ""}`,
      );
    }
  }
  ocmBinaryPath = candidate;
  return candidate;
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

function beginSession(prompt: string): string {
  const { stdout } = runOcm(["begin-session", prompt, "--agent", AGENT_NAME, "--json"]);
  const data = JSON.parse(stdout) as { sessionID: string };
  if (!data.sessionID) throw new Error(`begin-session returned no sessionID: ${stdout}`);
  return data.sessionID;
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

describe("improved-todowrite live e2e", () => {
  it("proves all four wrapper tools execute and preserve the todo-tree witness", async () => {
    const id = `todo-${randomUUID()}`.toLowerCase();
    const initialContent = `Initial ${id}`;
    const editedContent = `Edited ${id}`;
    let sessionID: string | undefined;

    try {
      sessionID = beginSession(
        `Call todo_plan exactly once with todos=[{id:"${id}",content:"${initialContent}",status:"pending",priority:"high",children:[]}]. Reply with ONLY READY.`,
      );
      const planPrompt = await waitForPublishedPrompt(
        sessionID,
        (text) => text.includes(VERIFICATION_PASSPHRASE) && text.includes(initialContent),
        SESSION_TIMEOUT_MS,
      );
      expect(planPrompt).toContain(VERIFICATION_PASSPHRASE);
      expect(planPrompt).toContain(initialContent);

      runOcm([
        "chat",
        sessionID,
        `Call todo_edit exactly once with ops=[{type:"update",id:"${id}",content:"${editedContent}"}]. Reply with ONLY READY.`,
      ]);
      const editPrompt = await waitForPublishedPrompt(
        sessionID,
        (text) => text.includes(VERIFICATION_PASSPHRASE) && text.includes(editedContent),
        SESSION_TIMEOUT_MS,
      );
      expect(editPrompt).toContain(editedContent);

      runOcm([
        "chat",
        sessionID,
        `Call todo_advance exactly once with id:"${id}" and action:"complete". Reply with ONLY READY.`,
      ]);
      const advancePrompt = await waitForPublishedPrompt(
        sessionID,
        (text) =>
          text.includes(VERIFICATION_PASSPHRASE) &&
          text.includes(editedContent) &&
          text.toLowerCase().includes("completed"),
        SESSION_TIMEOUT_MS,
      );
      expect(advancePrompt.toLowerCase()).toContain("completed");

      runOcm(["chat", sessionID, "Call todo_read exactly once. Reply with ONLY READY."]);
      const readPrompt = await waitForPublishedPrompt(
        sessionID,
        (text) =>
          text.includes(VERIFICATION_PASSPHRASE) &&
          text.includes(editedContent) &&
          text.toLowerCase().includes("completed"),
        SESSION_TIMEOUT_MS,
      );
      expect(readPrompt).toContain(editedContent);
      expect(readPrompt.toLowerCase()).toContain("completed");
    } finally {
      if (sessionID) {
        try { runOcm(["delete", sessionID]); } catch { /* best-effort */ }
      }
    }
  }, 220_000);
});
