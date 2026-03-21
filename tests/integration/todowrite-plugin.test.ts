import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

// TOOL_DIR is the plugin root (.config/ dir so OpenCode picks up the project-local
// config and discovers the plugin via .config/.opencode/plugins/
const TOOL_DIR = new URL("../../.config", import.meta.url).pathname;
const HOST = "127.0.0.1";
const MANAGER_PACKAGE = "git+https://github.com/dzackgarza/opencode-manager.git";
const MAX_BUFFER = 8 * 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 240_000;
const AGENT_NAME = "plugin-proof";

const VERIFICATION_PASSPHRASE = process.env.IMPROVED_TODOWRITE_TEST_PASSPHRASE?.trim();
if (!VERIFICATION_PASSPHRASE) throw new Error("IMPROVED_TODOWRITE_TEST_PASSPHRASE must be set");

let baseUrl = "";
let serverPort = 0;
let serverProcess: ChildProcess | undefined;
let serverLogs = "";

function waitMs(ms: number) {
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
        if (error) { reject(error); return; }
        resolve(port);
      });
    });
  });
}

async function startServer() {
  serverPort = await findFreePort();
  baseUrl = `http://${HOST}:${serverPort}`;
  serverLogs = "";

  const startedServer = spawn(
    "opencode",
    [
      "serve",
      "--hostname", HOST,
      "--port", String(serverPort),
      "--print-logs",
      "--log-level", "INFO",
    ],
    {
      cwd: TOOL_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Forward the passphrase so the todowrite CLI subprocess embeds it in
        // tool output (read via IMPROVED_TODO_VERIFICATION_PASSPHRASE).
        IMPROVED_TODO_VERIFICATION_PASSPHRASE: VERIFICATION_PASSPHRASE,
      },
    },
  );
  serverProcess = startedServer;

  const ready = `opencode server listening on ${baseUrl}`;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;

  const capture = (chunk: Buffer | string) => { serverLogs += chunk.toString(); };
  startedServer.stdout.on("data", capture);
  startedServer.stderr.on("data", capture);

  while (Date.now() < deadline) {
    if (serverLogs.includes(ready)) return;
    if (startedServer.exitCode !== null) {
      throw new Error(`OpenCode server exited early (${startedServer.exitCode}).\n${serverLogs}`);
    }
    await waitMs(200);
  }

  throw new Error(`Timed out waiting for OpenCode server at ${baseUrl}.\n${serverLogs}`);
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill("SIGINT");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) return;
    await waitMs(100);
  }
  serverProcess.kill("SIGKILL");
}

function runOcm(args: string[]) {
  const result = spawnSync(
    "uvx",
    ["--from", MANAGER_PACKAGE, "ocm", ...args],
    {
      env: { ...process.env, OPENCODE_BASE_URL: baseUrl },
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

// Create a session directly via the OpenCode REST API (no ocm wrapper).
// Returns the raw session ID string.
async function createSession(): Promise<string> {
  const res = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "test:improved-todowrite" }),
  });
  if (!res.ok) {
    throw new Error(`Create session failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json() as { id: string };
  if (typeof data.id !== "string" || !data.id) {
    throw new Error(`Create session returned no id: ${JSON.stringify(data)}`);
  }
  return data.id;
}

// Submit prompt to OpenCode REST API without waiting for the SSE stream to complete.
// The model run (including tool execution) happens server-side; use `ocm wait` to
// block until the session is idle after calling this.
async function submitPrompt(sessionID: string, prompt: string): Promise<void> {
  const res = await fetch(`${baseUrl}/session/${sessionID}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text: prompt }],
      agent: AGENT_NAME,
    }),
  });
  if (!res.ok) {
    throw new Error(`Submit prompt failed (${res.status}): ${await res.text()}`);
  }
  // Do not consume the body: the SSE stream runs server-side whether or not we read it.
  // Server continues processing tools + final model response asynchronously.
  await res.body?.cancel().catch(() => {});
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

beforeAll(async () => {
  await startServer();
}, 120_000);

afterAll(async () => {
  await stopServer();
}, 30_000);

describe("improved-todowrite live e2e", () => {
  it("proves todo_plan and todo_read execute and embed the verification passphrase", async () => {
    const nonce = randomUUID();
    let sessionID: string | undefined;

    try {
      // Create session and submit prompt via REST API (not ocm begin-session).
      // ocm begin-session requires assistant text after the turn; gpt-4.1 makes tool
      // calls without text in its first generation, so begin-session would fail.
      // We submit the prompt and immediately disconnect from the SSE stream; the
      // server continues processing tools server-side.
      //
      // Prompt design: interleave todo_plan → todo_advance → todo_read so that
      // todo_read returns DIFFERENT state (in-progress) from what todo_plan returned
      // (pending). This prevents gpt-4.1 from skipping todo_read as redundant.
      sessionID = await createSession();
      await submitPrompt(
        sessionID,
        `Step 1: call todo_plan with todos=[{content:"${nonce}",priority:"high"}].` +
        ` Step 2: call todo_advance with no arguments to mark the first task in-progress.` +
        ` Step 3: call todo_read to verify the updated state.` +
        ` These are three separate verification steps that MUST all be called in order.` +
        ` Reply READY after all three calls complete.`,
      );

      // Block until the session is fully idle (tools done, final reply produced).
      runOcm(["wait", sessionID, "--timeout-sec=180"]);

      // Read transcript once — no polling.
      const steps = readTranscriptSteps(sessionID);
      const rawTranscript = JSON.stringify(steps, null, 2);

      const planStep = steps.find(
        (s) => s.type === "tool" && s.tool === "todo_plan" && s.status === "completed",
      );
      expect(planStep, `todo_plan step missing. Steps:\n${rawTranscript}`).toBeDefined();
      expect(planStep!.outputText).toContain(VERIFICATION_PASSPHRASE);
      expect(planStep!.outputText).toContain(nonce);

      const readStep = steps.find(
        (s) => s.type === "tool" && s.tool === "todo_read" && s.status === "completed",
      );
      expect(readStep, `todo_read step missing. Steps:\n${rawTranscript}`).toBeDefined();
      expect(readStep!.outputText).toContain(VERIFICATION_PASSPHRASE);
      expect(readStep!.outputText).toContain(nonce);
    } finally {
      if (sessionID) {
        try { runOcm(["delete", sessionID]); } catch { /* best-effort */ }
      }
    }
  }, 200_000);
});
