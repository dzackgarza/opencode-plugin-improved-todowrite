import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir as systemTmpdir } from "node:os";
import { join } from "node:path";

const OPENCODE = process.env.OPENCODE_BIN || "opencode";
const TOOL_DIR = process.cwd();
const HOST = "127.0.0.1";
const MANAGER_PACKAGE = join(TOOL_DIR, "..", "opencode-manager");
const MAX_BUFFER = 8 * 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 240_000;
const PRIMARY_AGENT_NAME = "plugin-proof";
const VERIFICATION_PASSPHRASE =
  process.env.IMPROVED_TODO_VERIFICATION_PASSPHRASE?.trim() ||
  "SWORDFISH-TODO-TREE";

type ToolState = {
  output?: unknown;
  status?: string;
};

type SessionMessagePart = {
  type?: string;
  tool?: string;
  state?: ToolState;
};

type SessionMessage = {
  info?: {
    role?: string;
  };
  parts?: SessionMessagePart[];
};

type RuntimeSurface = {
  baseUrl: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

let baseUrl = "";
let serverPort = 0;
let serverProcess: ChildProcess | undefined;
let serverLogs = "";
let runtime: RuntimeSurface | undefined;
let runtimeCleanup: (() => Promise<void>) | undefined;

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

async function createIsolatedRuntime(cwd: string): Promise<{
  runtime: RuntimeSurface;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(systemTmpdir(), "improved-todo-opencode-"));
  const configHome = join(root, "config");
  const testHome = join(root, "home");
  await mkdir(configHome, { recursive: true });
  await mkdir(testHome, { recursive: true });
  return {
    runtime: {
      baseUrl: "",
      cwd,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        OPENCODE_TEST_HOME: testHome,
      },
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function resolveDirenvEnv(
  cwdForDirenv: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const result = spawnSync(
    "direnv",
    ["exec", cwdForDirenv, "env", "-0"],
    {
      cwd: cwdForDirenv,
      env,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Failed to resolve direnv environment for ${cwdForDirenv}.\nSTDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`,
    );
  }

  const resolved: NodeJS.ProcessEnv = {};
  for (const entry of (result.stdout ?? "").split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    resolved[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return resolved;
}

async function startServer() {
  spawnSync("direnv", ["allow", TOOL_DIR], { cwd: TOOL_DIR, timeout: 30_000 });

  serverPort = await findFreePort();
  baseUrl = `http://${HOST}:${serverPort}`;
  const isolated = await createIsolatedRuntime(TOOL_DIR);
  const resolvedEnv = await resolveDirenvEnv(TOOL_DIR, isolated.runtime.env);
  runtime = {
    ...isolated.runtime,
    baseUrl,
    env: resolvedEnv,
  };
  runtimeCleanup = isolated.cleanup;
  serverLogs = "";

  const startedServer = spawn(
    "direnv",
    [
      "exec",
      TOOL_DIR,
      OPENCODE,
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
      env: runtime.env,
      stdio: ["ignore", "pipe", "pipe"],
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
        `Custom OpenCode server exited early (${startedServer.exitCode}).\n${serverLogs}`,
      );
    }
    await wait(200);
  }

  throw new Error(
    `Timed out waiting for custom OpenCode server at ${baseUrl}.\n${serverLogs}`,
  );
}

async function stopServer() {
  try {
    if (!serverProcess || serverProcess.exitCode !== null) return;

    serverProcess.kill("SIGINT");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (serverProcess.exitCode !== null) return;
      await wait(100);
    }

    serverProcess.kill("SIGKILL");
  } finally {
    await runtimeCleanup?.();
    runtimeCleanup = undefined;
    runtime = undefined;
  }
}

function runSessionCommand(args: string[]) {
  const result = spawnSync(
    "npx",
    ["--yes", `--package=${MANAGER_PACKAGE}`, "opx-session", ...args],
    {
      cwd: runtime?.cwd ?? TOOL_DIR,
      env: {
        ...(runtime?.env ?? process.env),
        OPENCODE_BASE_URL: runtime?.baseUrl ?? baseUrl,
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
      `Manager command failed: opx-session ${args.join(" ")}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }

  return { stdout, stderr };
}

function createSession(title: string) {
  return JSON.parse(
    runSessionCommand(["create", "--title", title, "--json"]).stdout,
  ) as { id: string };
}

function promptSession(sessionID: string, prompt: string) {
  runSessionCommand([
    "prompt",
    sessionID,
    prompt,
    "--agent",
    PRIMARY_AGENT_NAME,
    "--no-reply",
  ]);
}

function safeDeleteSession(sessionID: string | undefined) {
  if (!sessionID) return;
  try {
    runSessionCommand(["delete", sessionID, "--json"]);
  } catch {
    // best-effort cleanup in a noisy shared environment
  }
}

function readMessages(sessionID: string): SessionMessage[] {
  const { stdout } = runSessionCommand(["messages", sessionID, "--json"]);
  return JSON.parse(stdout) as SessionMessage[];
}

async function waitForCompletedToolUse(
  sessionID: string,
  toolName: string,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = readMessages(sessionID);
    const match = messages
      .filter((message) => message.info?.role === "assistant")
      .flatMap((message) => message.parts ?? [])
      .filter(
        (part): part is Required<Pick<SessionMessagePart, "tool" | "state">> &
          SessionMessagePart =>
          part.type === "tool" &&
          part.tool === toolName &&
          typeof part.state === "object" &&
          part.state !== null &&
          part.state.status === "completed",
      )
      .at(-1);

    if (match) {
      return match.state;
    }
    await wait(1_000);
  }

  throw new Error(
    `Timed out waiting for completed tool use ${toolName}.\n${JSON.stringify(readMessages(sessionID), null, 2)}`,
  );
}

beforeAll(async () => {
  await startServer();
}, 120_000);

afterAll(async () => {
  await stopServer();
}, 30_000);

describe("improved-todowrite live e2e", () => {
  it("proves improved_todowrite and improved_todoread execute in a manager-driven live session", async () => {
    const sessionID = createSession(`todowrite:${Date.now()}`).id;

    try {
      promptSession(
        sessionID,
        "Call the tool `improved_todowrite` directly. Do not use bash, shell, task, or any CLI command. Set `todos` to exactly this JSON array: [{\"id\":\"phase-1\",\"content\":\"Ship persistence layer\",\"status\":\"pending\",\"priority\":\"high\",\"children\":[]}]. After the tool call finishes, reply with ONLY READY.",
      );

      const writeTool = await waitForCompletedToolUse(
        sessionID,
        "improved_todowrite",
      );
      const writeOutput =
        typeof writeTool.output === "string" ? writeTool.output : "";

      expect(writeOutput).toContain(VERIFICATION_PASSPHRASE);
      expect(writeOutput).toContain('"id": "phase-1"');

      promptSession(
        sessionID,
        "Call the tool `improved_todoread` directly. Do not use bash, shell, task, or any CLI command. After the tool call finishes, reply with ONLY READY.",
      );

      const readTool = await waitForCompletedToolUse(
        sessionID,
        "improved_todoread",
      );
      const readOutput =
        typeof readTool.output === "string" ? readTool.output : "";

      expect(readOutput).toContain(VERIFICATION_PASSPHRASE);
      expect(readOutput).toContain("- [ ] Ship persistence layer");
      expect(readOutput).toContain('"id": "phase-1"');
    } finally {
      safeDeleteSession(sessionID);
    }
  }, 200_000);
});
