import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { saveAgentConfig } from "../agents/agents.mjs";
import { executeStep } from "./run-step.mjs";
import { runChange } from "./run.mjs";
import { appDataFile } from "../kernel/appdata.mjs";

const CLAUDE = `
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i < 0 ? "" : argv[i + 1]; };
try { readFileSync(0, "utf8"); } catch {}
if (process.env.CLAUDE_CALLED) writeFileSync(process.env.CLAUDE_CALLED, "yes");
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "done\\n\\n## HANDOFF\\nreserve ran", session_id: at("--session-id"), total_cost_usd: 0.01 }) + "\\n");
`;

const LIMITED_CODEX = `
import { readFileSync, writeFileSync } from "node:fs";
try { readFileSync(0, "utf8"); } catch {}
writeFileSync("touched-by-primary.txt", "side effect");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "limited-thread" }) + "\\n");
process.stderr.write("usage limit reached\\n");
process.exit(1);
`;

const task = () => ({
  id: "worker", number: 1, subject: "candidate fallback", status: "in_progress", kind: "auto",
  description: "exercise ordered candidates", produces: ["out.txt"], verify: "true", retry_limit: 1,
});

describe("ordered candidate fallback", () => {
  let tmp;
  let oldAppData;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cu-fallback-"));
    oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, "appdata");
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "fallback@example.invalid"], { cwd: tmp });
    execFileSync("git", ["config", "user.name", "Fallback Test"], { cwd: tmp });
    writeFileSync(path.join(tmp, "base.txt"), "base");
    execFileSync("git", ["add", "base.txt"], { cwd: tmp });
    execFileSync("git", ["commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
  });
  afterEach(() => {
    if (oldAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = oldAppData;
    rmSync(tmp, { recursive: true, force: true });
  });

  function configure(candidates) {
    saveAgentConfig({ version: 5, duties: { worker: { mode: "always", candidates } }, routes: {} });
  }

  it("skips a missing Codex binary, drops cross-engine inherit, and runs Anthropic", async () => {
    configure([
      { provider: "openai", model: "gpt-5.6-sol" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ]);
    const fake = path.join(tmp, "claude.mjs");
    writeFileSync(fake, CLAUDE);
    const t = task();
    const result = await executeStep({
      task: t, board: { version: 2, todos: [t] }, cwd: tmp, bind: false,
      inherit: "codex-parent", codexBin: path.join(tmp, "missing-codex.exe"),
      claudeBin: [process.execPath, fake],
    });
    expect(result).toMatchObject({
      ok: true, provider: "anthropic", guard: "active", inherit_dropped: true,
      fallback: [{ provider: "openai", model: "gpt-5.6-sol", reason: "missing" }],
    });

    const root = { id: "change", number: 9, subject: "change", status: "queue", change: true, depends_on: [t.id], budget_usd: 1 };
    await runChange({
      data: { version: 2, todos: [root, { ...t, status: "queue" }] }, change: 9, dry: false, cwd: tmp, history: [],
      effects: {
        executeStep: async () => result,
        reviewStep: async () => ({ approved: true, ok: true, skipped: true }),
        stepBase: async () => ({ ok: false, error: "not needed" }),
        priorChanges: async () => ({ ok: true }), ownChanges: async () => ({ ok: true, skip: true }),
        setStatus: async () => {}, recordHandoff: async () => ({ written: true }), recordIssue: async () => ({ written: true }),
        recordAttempt: async () => ({ written: true, snapshot: null }), stepCost: async () => 0.01,
        runVerify: async () => ({ code: 0, stdout: "", stderr: "" }),
        reconcile: async () => ({ outcome: "ok", outcome_reason: "verify:ok" }),
      },
    });
    const events = readFileSync(appDataFile("run-events.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    expect(events.find((event) => event.kind === "worker_done")).toMatchObject({
      fallback: result.fallback, inherit_dropped: true, guard: "active",
    });
  });

  it("does not run the reserve after a limited worker changed the tree", async () => {
    configure([
      { provider: "openai", model: "gpt-5.6-sol" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ]);
    const codex = path.join(tmp, "codex.mjs");
    const claude = path.join(tmp, "claude.mjs");
    const called = path.join(tmp, "claude-called.txt");
    writeFileSync(codex, LIMITED_CODEX);
    writeFileSync(claude, CLAUDE);
    process.env.CLAUDE_CALLED = called;
    const t = task();
    const result = await executeStep({
      task: t, board: { version: 2, todos: [t] }, cwd: tmp, bind: false,
      codexBin: [process.execPath, codex], claudeBin: [process.execPath, claude],
    });
    delete process.env.CLAUDE_CALLED;
    expect(result).toMatchObject({ ok: false, provider: "openai", failureReason: "limit", guard: "absent", fallback: [] });
    expect(existsSync(path.join(tmp, "touched-by-primary.txt"))).toBe(true);
    expect(existsSync(called)).toBe(false);

    const root = { id: "change", number: 10, subject: "change", status: "queue", change: true, depends_on: [t.id], budget_usd: 1 };
    const report = await runChange({
      data: { version: 2, todos: [root, { ...t, status: "queue" }] }, change: 10, dry: false, cwd: tmp, history: [],
      effects: {
        executeStep: async () => result,
        stepBase: async () => ({ ok: false, error: "not needed" }), priorChanges: async () => ({ ok: true }),
        setStatus: async () => {}, recordHandoff: async () => ({ written: true }), recordIssue: async () => ({ written: true }),
        recordAttempt: async () => ({ written: true, snapshot: null }), stepCost: async () => 0,
      },
    });
    expect(report.stop).toMatchObject({ kind: "retry", task: { number: 1 } });
  });

  it("does not trust a truncated snapshot to start the reserve", async () => {
    configure([
      { provider: "openai", model: "gpt-5.6-sol" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ]);
    const codex = path.join(tmp, "codex.mjs");
    const claude = path.join(tmp, "claude.mjs");
    const called = path.join(tmp, "claude-called.txt");
    writeFileSync(codex, LIMITED_CODEX);
    writeFileSync(claude, CLAUDE);
    for (let i = 0; i <= 2000; i += 1) {
      const file = path.join(tmp, "bulk", `untracked-${i}.txt`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "existing");
    }
    process.env.CLAUDE_CALLED = called;
    const t = task();
    const result = await executeStep({
      task: t, board: { version: 2, todos: [t] }, cwd: tmp, bind: false,
      codexBin: [process.execPath, codex], claudeBin: [process.execPath, claude],
    });
    delete process.env.CLAUDE_CALLED;
    expect(result).toMatchObject({ ok: false, failureReason: "limit", fallback: [] });
    expect(existsSync(path.join(tmp, "touched-by-primary.txt"))).toBe(true);
    expect(existsSync(called)).toBe(false);
  });

  it("reports every reason when all candidates are unavailable", async () => {
    configure([
      { provider: "openai", model: "gpt-5.6-sol" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ]);
    const t = task();
    const result = await executeStep({
      task: t, board: { version: 2, todos: [t] }, cwd: tmp, bind: false,
      codexBin: path.join(tmp, "missing-codex.exe"), claudeBin: path.join(tmp, "missing-claude.exe"),
    });
    expect(result.failureReason).toBe("candidates_exhausted");
    expect(result.fallback).toEqual([
      { provider: "openai", model: "gpt-5.6-sol", reason: "missing" },
      { provider: "anthropic", model: "claude-sonnet-5-5", reason: "missing" },
    ]);
    expect(result.error).toContain("candidates_exhausted");
  });

  it("CLI preflight stops a --go run before the first step when no candidate is available", () => {
    configure([
      { provider: "openai", model: "gpt-5.6-sol" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ]);
    const appDir = path.dirname(appDataFile("todos.json"));
    mkdirSync(appDir, { recursive: true });
    const worker = { ...task(), id: "worker-cli", number: 2, status: "queue" };
    writeFileSync(appDataFile("todos.json"), JSON.stringify({
      version: 2,
      todos: [
        { id: "change-cli", number: 1, subject: "preflight", status: "queue", change: true,
          depends_on: [worker.id], budget_usd: 1 },
        worker,
      ],
    }));
    const runModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "run.mjs");
    const invoke = `import { run } from ${JSON.stringify(pathToFileURL(runModule).href)}; await run(["1", "--go"]);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", invoke], {
      cwd: tmp,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        APPDATA: process.env.APPDATA,
        CLAUDE_BIN: path.join(tmp, "missing-claude.exe"),
        CODEX_BIN: path.join(tmp, "missing-codex.exe"),
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no available candidate.*worker/i);
    expect(JSON.parse(readFileSync(appDataFile("todos.json"), "utf8")).todos[1].status).toBe("queue");
    expect(existsSync(appDataFile("run-events.jsonl"))).toBe(false);
  });
});
