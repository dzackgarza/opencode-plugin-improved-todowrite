import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

const OPENCODE = process.env.OPENCODE_BIN || "opencode";
const TOOL_DIR = process.cwd();
const MAX_BUFFER = 8 * 1024 * 1024;
const VERIFICATION_PASSPHRASE = "SWORDFISH-TODO-TREE";

type ToolUseEvent = {
  type: "tool_use";
  part: {
    type: "tool";
    tool: string;
    state: {
      status?: string;
      output?: string;
    };
  };
};

function run(prompt: string, timeout = 180_000, format: "default" | "json" = "default") {
  spawnSync("direnv", ["allow", TOOL_DIR], { cwd: TOOL_DIR, timeout: 30_000 });
  const args = ["exec", TOOL_DIR, OPENCODE, "run", "--agent", "Minimal"];
  if (format === "json") args.push("--format", "json");
  args.push(prompt);
  const result = spawnSync(
    "direnv",
    args,
    { cwd: process.env.HOME, encoding: "utf8", timeout, maxBuffer: MAX_BUFFER },
  );
  if (result.error) throw result.error;
  return (result.stdout ?? "") + (result.stderr ?? "");
}

function parseJsonEvents(output: string): unknown[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function runJson(prompt: string, timeout = 180_000) {
  return parseJsonEvents(run(prompt, timeout, "json"));
}

function findCompletedToolUse(events: unknown[], toolName: string): ToolUseEvent {
  const match = events.find(
    (event): event is ToolUseEvent =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "tool_use" &&
      "part" in event &&
      typeof event.part === "object" &&
      event.part !== null &&
      "type" in event.part &&
      event.part.type === "tool" &&
      "tool" in event.part &&
      event.part.tool === toolName &&
      "state" in event.part &&
      typeof event.part.state === "object" &&
      event.part.state !== null &&
      "status" in event.part.state &&
      event.part.state.status === "completed",
  );
  expect(match).toBeDefined();
  return match!;
}

describe("improved-todowrite live e2e", () => {
  it("proves improved_todowrite and improved_todoread both execute in a live OpenCode session", () => {
    const events = runJson(
      "Use improved_todowrite to write one top-level todo with id=phase-1, content='Ship persistence layer', status='pending', priority='high'. Then use improved_todoread. After both tool calls finish, reply with ONLY READY.",
    );
    const writeTool = findCompletedToolUse(events, "improved_todowrite");
    const readTool = findCompletedToolUse(events, "improved_todoread");

    expect(writeTool.part.state.output).toContain(VERIFICATION_PASSPHRASE);
    expect(readTool.part.state.output).toContain(VERIFICATION_PASSPHRASE);
    expect(readTool.part.state.output).toContain("- [ ] Ship persistence layer");
    expect(readTool.part.state.output).toContain('"id": "phase-1"');
  }, 200_000);
});
