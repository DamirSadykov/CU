import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkPayload, claudeGuardSettings } from "./guard.mjs";
import { codexRules } from "./policy.mjs";
import { CLAUDE_CODE_ENGINE, claudeCodeArgv, hasClaudeGuard } from "../models/claude-code.mjs";

describe("guard policy", () => {
  it.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])("blocks %s outside cwd", (tool) => {
    expect(checkPayload({ tool_name: tool, cwd: "C:/work/repo", tool_input: { file_path: "C:/other/file.txt" } }).allowed).toBe(false);
    expect(checkPayload({ tool_name: tool, cwd: "C:/work/repo", tool_input: { file_path: "src/file.txt" } }).allowed).toBe(true);
  });

  it("checks Bash command policy", () => {
    expect(checkPayload({ tool_name: "Bash", tool_input: { command: "git reset --hard" } })).toMatchObject({ allowed: false });
    expect(checkPayload({ tool_name: "Bash", tool_input: { command: "npm test" } })).toEqual({ allowed: true });
  });

  it("builds Claude settings for every guarded writing tool", () => {
    const settings = JSON.parse(claudeGuardSettings("C:/CU/scripts/cli.mjs"));
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Write|Edit|MultiEdit|NotebookEdit|Bash");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("cli.mjs");
  });

  it("merges the CU hook into supplied Claude settings for write-capable runs", () => {
    const supplied = JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { PreToolUse: [{ matcher: "Read", hooks: [] }] } });
    const { args } = claudeCodeArgv({}, { sandbox: "workspace-write", settings: supplied });
    const merged = args[args.indexOf("--settings") + 1];
    expect(JSON.parse(merged).permissions).toEqual({ allow: ["Read"] });
    expect(JSON.parse(merged).hooks.PreToolUse).toHaveLength(2);
    expect(hasClaudeGuard(merged)).toBe(true);
    expect(CLAUDE_CODE_ENGINE.guard({ sandbox: "workspace-write", settings: supplied })).toEqual({ active: true, reason: null });
  });

  it("does not report arbitrary Claude settings as an active guard", () => {
    const supplied = JSON.stringify({ permissions: { allow: ["Read"] } });
    expect(CLAUDE_CODE_ENGINE.guard({ settings: supplied })).toMatchObject({ active: false });
  });

  it("does not let a supplied settingsPath replace the guard on a write run", () => {
    const settingsPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const { args } = claudeCodeArgv({}, { sandbox: "workspace-write", settingsPath });
    const merged = args[args.indexOf("--settings") + 1];
    expect(merged).not.toBe(settingsPath);
    expect(hasClaudeGuard(merged)).toBe(true);
    expect(CLAUDE_CODE_ENGINE.guard({ sandbox: "workspace-write", settingsPath })).toEqual({ active: true, reason: null });
  });

  it("prints deterministic forbidden prefix rules", () => {
    expect(codexRules()).toContain('prefix_rule(pattern=["git", ["reset"');
    expect(codexRules()).toContain('decision="forbidden"');
    expect(codexRules()).toBe(codexRules());
    expect(codexRules()).toBe(readFileSync(fileURLToPath(new URL("./cu-guard.rules", import.meta.url)), "utf8"));
  });
});
