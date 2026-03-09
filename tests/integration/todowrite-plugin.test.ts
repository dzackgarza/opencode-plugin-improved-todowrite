import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

const OPENCODE = "/home/dzack/.opencode/bin/opencode";
const TOOL_DIR = "/home/dzack/opencode-plugins/improved-todowrite";
const MAX_BUFFER = 8 * 1024 * 1024;

function run(prompt: string, timeout = 180_000) {
  spawnSync("direnv", ["allow", TOOL_DIR], { cwd: TOOL_DIR, timeout: 30_000 });
  const result = spawnSync(
    "direnv",
    ["exec", TOOL_DIR, OPENCODE, "run", "--agent", "Minimal", prompt],
    { cwd: process.env.HOME, encoding: "utf8", timeout, maxBuffer: MAX_BUFFER },
  );
  if (result.error) throw result.error;
  return (result.stdout ?? "") + (result.stderr ?? "");
}

describe("improved-todowrite live e2e", () => {
  it("proves improved_todowrite and improved_todoread both execute in a live OpenCode session", () => {
    const output = run(
      "Use improved_todowrite to write one top-level todo with id=phase-1, content='Ship persistence layer', status='pending', priority='high'. Then use improved_todoread. After both tool calls finish, reply with ONLY READY.",
    );
    expect(output).toContain("improved_todowrite");
    expect(output).toContain("improved_todoread");
    expect(output).toContain("READY");
  }, 200_000);
});
