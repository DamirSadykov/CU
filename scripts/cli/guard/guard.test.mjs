import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPayload, claudeGuardSettings } from "./guard.mjs";
import { codexRules } from "./policy.mjs";
import { CLAUDE_CODE_ENGINE, claudeCodeArgv, hasClaudeGuard } from "../models/claude-code.mjs";
import { CODEX_ENGINE } from "../models/codex.mjs";
import { createCandidate } from "../models/candidate.mjs";

const cli = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const payload = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });
const invokeGuard = (args, input, env) => spawnSync(process.execPath, [cli, "guard", ...args], {
  input, env: { ...process.env, TRACKER_SESSION_KIND: "", CU_RUNNER_GUARD_PROOF: "", ...env }, encoding: "utf8", windowsHide: true,
});

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

describe("runner guard scope", () => {
  it.each(["", "interactive", "collaborator"])("leaves the %s main session unrestricted", (kind) => {
    for (const args of [[], ["--host", "codex"]]) {
      const result = invokeGuard(args, payload("git checkout -- src/file.txt"), { TRACKER_SESSION_KIND: kind });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });

  it("denies commands only in runner children using each host's protocol", () => {
    const env = { TRACKER_SESSION_KIND: "runner" };
    const claude = invokeGuard([], payload("git reset --hard"), env);
    expect(claude.status).toBe(2);
    expect(claude.stderr).toContain("git changes the worktree or history");
    const codex = invokeGuard(["--host", "codex"], payload("git reset --hard"), env);
    expect(codex.status).toBe(0);
    expect(JSON.parse(codex.stdout)).toMatchObject({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny",
    } });
    const safe = invokeGuard(["--host", "codex"], payload("npm test"), env);
    expect(safe.status).toBe(0);
    expect(safe.stdout).toBe("");
  });

  it("does not confuse a configured or disabled hook with observed protection", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cu-guard-check-"));
    const hooksFile = path.join(dir, "hooks.json");
    try {
      expect(CODEX_ENGINE.guard({ hooksFile })).toMatchObject({ active: false, configured: false });
      const hook = { type: "command", command: 'node "C:/CU/scripts/cli.mjs" guard --host codex' };
      writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] } }));
      expect(CODEX_ENGINE.guard({ hooksFile })).toMatchObject({ active: false, configured: true });
      writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [] } }));
      expect(CODEX_ENGINE.guard({ hooksFile })).toMatchObject({ active: false, configured: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("still denies a command when the observation file cannot be written", () => {
    const result = invokeGuard(["--host", "codex"], payload("git reset --hard"), {
      TRACKER_SESSION_KIND: "runner", CU_RUNNER_GUARD_PROOF: "Z:/definitely-absent/guard-proof",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("cleans up observation state after a failed agent launch", async () => {
    let proofFile;
    const result = await createCandidate({ provider: "openai", model: "gpt-5.6-sol" }).run({
      spawn: async (_file, _args, options) => {
        proofFile = options.env.CU_RUNNER_GUARD_PROOF;
        throw Object.assign(new Error("spawn missing"), { code: "ENOENT" });
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "missing", guard: "absent" });
    expect(existsSync(path.dirname(proofFile))).toBe(false);
  });

  it.each([false, true])("reports actual hook execution per candidate run (hook ran: %s)", async (hookRan) => {
    let proofFile;
    const result = await createCandidate({ provider: "openai", model: "gpt-5.6-sol" }).run({
      sandbox: "workspace-write", inherit: "parent-thread", env: { PATH: process.env.PATH },
      spawn: async (_file, args, options) => {
        expect(args).toContain("fork");
        expect(options.env.TRACKER_SESSION_KIND).toBe("runner");
        proofFile = options.env.CU_RUNNER_GUARD_PROOF;
        expect(existsSync(proofFile)).toBe(false);
        if (hookRan) {
          const reply = invokeGuard(["--host", "codex"], payload("git status"), options.env);
          expect(reply.status).toBe(0);
        }
        return { code: 0, stderr: "", stdout: JSON.stringify({ type: "thread.started", thread_id: "child-thread" }) };
      },
    });
    expect(result.guard).toBe(hookRan ? "active" : "absent");
    expect(existsSync(path.dirname(proofFile))).toBe(false);
  });
});
