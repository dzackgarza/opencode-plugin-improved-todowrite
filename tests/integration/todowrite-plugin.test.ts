import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

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

const VERIFICATION_PASSPHRASE = process.env.IMPROVED_TODOWRITE_TEST_PASSPHRASE?.trim();
if (!VERIFICATION_PASSPHRASE) throw new Error("IMPROVED_TODOWRITE_TEST_PASSPHRASE must be set");

function runOcm(args: string[]) {
  const result = spawnSync(
    "uvx",
    ["--from", MANAGER_PACKAGE, "ocm", ...args],
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

// begin-session submits the prompt and returns immediately.
// Use ocm wait to block until the full turn (including tool calls) completes.
function beginSession(prompt: string): string {
  const { stdout } = runOcm(["begin-session", prompt, "--agent", AGENT_NAME, "--json"]);
  const data = JSON.parse(stdout) as { sessionID: string };
  if (!data.sessionID) throw new Error(`begin-session returned no sessionID: ${stdout}`);
  return data.sessionID;
}

function waitIdle(sessionID: string) {
  runOcm(["wait", sessionID, "--timeout-sec=180"]);
}

type TranscriptStep = {
  type: string;
  tool?: string;
  status?: string;
  outputText?: string;
};

function readTranscriptSteps(sessionID: string): TranscriptStep[] {
  const { stdout } = runOcm(["transcript", sessionID, "--json"]);
  const data = JSON.parse(stdout) as {
    turns: Array<{
      assistantMessages: Array<{ steps: Array<TranscriptStep | null> }>;
    }>;
  };
  return data.turns.flatMap((turn) =>
    turn.assistantMessages.flatMap((msg) =>
      (msg.steps ?? []).filter((s): s is TranscriptStep => s !== null),
    ),
  );
}

describe("improved-todowrite live e2e", () => {
  it("proves all four wrapper tools execute and preserve the todo-tree witness", () => {
    const nonce = randomUUID();
    let sessionID: string | undefined;

    try {
      // begin-session submits the prompt and returns the session ID immediately.
      // The agent then calls todo_plan → todo_edit → todo_advance → todo_read
      // in one turn so each wrapper entrypoint is exercised against the live CLI.
      sessionID = beginSession(
        `Step 1: call todo_plan with todos=[{content:"${nonce}",priority:"high"}]. ` +
        `Step 2: call todo_edit with ops=[{type:"update",id:"${nonce.toLowerCase()}",content:"${nonce} edited"}]. ` +
        `Step 3: call todo_advance with id:"${nonce.toLowerCase()}" and action:"complete". ` +
        `Step 4: call todo_read to verify the updated state. ` +
        `These are four separate verification steps that MUST all be called in order. ` +
        `Reply READY after all four calls complete.`,
      );

      // Block until the full turn is complete (tool calls + final text).
      waitIdle(sessionID);

      const steps = readTranscriptSteps(sessionID);
      const rawTranscript = JSON.stringify(steps, null, 2);

      const planStep = steps.find(
        (s) => s.type === "tool" && s.tool === "todo_plan" && s.status === "completed",
      );
      expect(planStep, `todo_plan step missing. Steps:\n${rawTranscript}`).toBeDefined();
      expect(planStep!.outputText).toContain(VERIFICATION_PASSPHRASE);
      expect(planStep!.outputText).toContain(nonce);

      const editStep = steps.find(
        (s) => s.type === "tool" && s.tool === "todo_edit" && s.status === "completed",
      );
      expect(editStep, `todo_edit step missing. Steps:\n${rawTranscript}`).toBeDefined();
      expect(editStep!.outputText).toContain(`${nonce} edited`);

      const advanceStep = steps.find(
        (s) => s.type === "tool" && s.tool === "todo_advance" && s.status === "completed",
      );
      expect(advanceStep, `todo_advance step missing. Steps:\n${rawTranscript}`).toBeDefined();
      expect(advanceStep!.outputText).toContain(VERIFICATION_PASSPHRASE);

      const readStep = steps.find(
        (s) => s.type === "tool" && s.tool === "todo_read" && s.status === "completed",
      );
      expect(readStep, `todo_read step missing. Steps:\n${rawTranscript}`).toBeDefined();
      expect(readStep!.outputText).toContain(VERIFICATION_PASSPHRASE);
      expect(readStep!.outputText).toContain(`${nonce} edited`);
    } finally {
      if (sessionID) {
        try { runOcm(["delete", sessionID]); } catch { /* best-effort */ }
      }
    }
  }, 200_000);
});
