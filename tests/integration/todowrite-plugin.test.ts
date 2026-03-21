import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

const OPENCODE = "opencode";
// TOOL_DIR is the plugin root (.config/ dir so OpenCode picks up the project-local config)
const TOOL_DIR = new URL("../../.config", import.meta.url).pathname;
const HOST = "127.0.0.1";
const MANAGER_PACKAGE = "git+https://github.com/dzackgarza/opencode-manager.git";
const MAX_BUFFER = 8 * 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 240_000;
const PRIMARY_AGENT_NAME = "plugin-proof";
const VERIFICATION_PASSPHRASE = process.env.IMPROVED_TODOWRITE_TEST_PASSPHRASE?.trim();
if (!VERIFICATION_PASSPHRASE) throw new Error("IMPROVED_TODOWRITE_TEST_PASSPHRASE must be set");

let baseUrl = "";
let serverPort = 0;
let serverProcess: ChildProcess | undefined;
let serverLogs = "";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a TCP port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function startServer() {
  serverPort = await findFreePort();
  baseUrl = `http://${HOST}:${serverPort}`;
  serverLogs = "";

  // Run from TOOL_DIR (.config/) so OpenCode picks up opencode.json + plugins/
  // from that directory (project-local config with plugin-proof agent).
  const startedServer = spawn(
    OPENCODE,
    [
      "serve",
      "--hostname",
      HOST,
      "--port",
      String(serverPort),
      "--print-logs",
      "--log-level",
      "INFO",
    ],
    {
      cwd: TOOL_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Forward the passphrase so the todowrite CLI subprocess can embed it
        // in tool output (read via IMPROVED_TODO_VERIFICATION_PASSPHRASE).
        IMPROVED_TODO_VERIFICATION_PASSPHRASE: VERIFICATION_PASSPHRASE,
      },
    },
  );
  serverProcess = startedServer;

  const ready = `opencode server listening on ${baseUrl}`;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;

  const capture = (chunk: Buffer | string) => {
    serverLogs += chunk.toString();
  };
  startedServer.stdout.on("data", capture);
  startedServer.stderr.on("data", capture);

  while (Date.now() < deadline) {
    if (serverLogs.includes(ready)) {
      return;
    }
    if (startedServer.exitCode !== null) {
      throw new Error(
        `OpenCode server exited early (${startedServer.exitCode}).\n${serverLogs}`,
      );
    }
    await wait(200);
  }

  throw new Error(
    `Timed out waiting for OpenCode server at ${baseUrl}.\n${serverLogs}`,
  );
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;

  serverProcess.kill("SIGINT");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) return;
    await wait(100);
  }

  serverProcess.kill("SIGKILL");
}

function runOpxCommand(args: string[]) {
  const result = spawnSync(
    "uvx",
    ["--from", MANAGER_PACKAGE, "ocm", ...args],
    {
      cwd: TOOL_DIR,
      env: {
        ...process.env,
        OPENCODE_BASE_URL: baseUrl,
      },
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
      `ocm command failed: ocm ${args.join(" ")}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  return { stdout, stderr };
}

function beginSession(prompt: string): string {
  const { stdout } = runOpxCommand([
    "begin-session",
    prompt,
    "--agent",
    PRIMARY_AGENT_NAME,
    "--json",
  ]);
  const data = JSON.parse(stdout) as { sessionID: string };
  return data.sessionID;
}

function chatSession(sessionID: string, prompt: string) {
  runOpxCommand([
    "chat",
    sessionID,
    prompt,
  ]);
}

function safeDeleteSession(sessionID: string | undefined) {
  if (!sessionID) return;
  try {
    runOpxCommand(["delete", sessionID]);
  } catch {
    // best-effort cleanup
  }
}

type TranscriptStep = {
  type: string;
  tool?: string;
  status?: string;
  outputText?: string;
};

function readTranscriptSteps(sessionID: string): TranscriptStep[] {
  const { stdout } = runOpxCommand([
    "transcript",
    sessionID,
    "--json",
  ]);
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

async function waitForCompletedToolUse(
  sessionID: string,
  toolName: string,
  timeoutMs = 180_000,
): Promise<{ output: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const steps = readTranscriptSteps(sessionID);
    const match = steps.findLast(
      (s) =>
        s.type === "tool" && s.tool === toolName && s.status === "completed",
    );

    if (match) {
      return { output: typeof match.outputText === "string" ? match.outputText : "" };
    }
    await wait(1_000);
  }

  let rawTranscript = "(unavailable)";
  try {
    const { stdout } = runOpxCommand(["transcript", sessionID, "--json"]);
    rawTranscript = stdout;
  } catch (e) {
    rawTranscript = String(e);
  }
  throw new Error(
    `Timed out waiting for completed tool use "${toolName}".\nRAW TRANSCRIPT:\n${rawTranscript}`,
  );
}

beforeAll(async () => {
  await startServer();
}, 120_000);

afterAll(async () => {
  await stopServer();
}, 30_000);

describe("improved-todowrite live e2e", () => {
  it("proves todo_plan and todo_read execute in a manager-driven live session", async () => {
    const nonce = randomUUID();
    let sessionID: string | undefined;

    try {
      sessionID = beginSession(
        `Call todo_plan with todos=[{content:"${nonce}",priority:"high"}]. Reply READY when done.`,
      );

      const planTool = await waitForCompletedToolUse(sessionID, "todo_plan");
      expect(planTool.output).toContain(VERIFICATION_PASSPHRASE);
      expect(planTool.output).toContain(nonce);

      chatSession(
        sessionID,
        "Call the tool `todo_read` directly. Do not use any other tool. After the tool call finishes, reply with ONLY READY.",
      );

      const readTool = await waitForCompletedToolUse(sessionID, "todo_read");
      expect(readTool.output).toContain(VERIFICATION_PASSPHRASE);
      expect(readTool.output).toContain(nonce);
    } finally {
      safeDeleteSession(sessionID);
    }
  }, 200_000);
});
