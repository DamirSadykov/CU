import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { appDataFile } from "../kernel/appdata.mjs";
import { gitBase, UNTRACKED_SNAPSHOT_LIMIT } from "./red-gate.mjs";
import { reconcileTodo } from "./outcome.mjs";

const task = (extra = {}) => ({
  id: "worker", number: 1, subject: "produce something", status: "in_progress", kind: "auto",
  description: "exercise the produces predicate", verify: "true", retry_limit: 2, ...extra,
});

function initRepo() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cu-missing-"));
  const oldAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(tmp, "appdata");
  execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "missing@example.invalid"], { cwd: tmp });
  execFileSync("git", ["config", "user.name", "Missing Test"], { cwd: tmp });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: tmp });
  writeFileSync(path.join(tmp, "base.txt"), "base");
  execFileSync("git", ["add", "base.txt"], { cwd: tmp });
  execFileSync("git", ["commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
  const write = (rel, text) => {
    const full = path.isAbsolute(rel) ? rel : path.join(tmp, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    return full;
  };
  const bindSessionStart = (t, session, ts) => {
    const file = appDataFile("task-sessions.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ts, session, task: t.id, event: "start", source: "run", provider: "openai" }) + "\n");
  };
  const reconcile = (t) => {
    const file = appDataFile("todos.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const data = { version: 2, todos: [t] };
    writeFileSync(file, JSON.stringify(data));
    return reconcileTodo({ file, data, todo: data.todos[0], verify: "ok", cwd: tmp }).report;
  };
  const stepBase = (t) => {
    t.step_base = gitBase(tmp, { produces: t.produces }).sha;
    return t;
  };
  const close = () => {
    if (oldAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = oldAppData;
    rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, write, bindSessionStart, reconcile, stepBase, close };
}

describe("missing produces after a green verify", () => {
  let repo;
  beforeEach(() => { repo = initRepo(); });
  afterEach(() => repo.close());

  it("t#1079: a directory in produces is produced when the step wrote a file inside it", () => {
    const t = repo.stepBase(task({ produces: ["src-tauri/tests/fixtures/projects"] }));
    repo.write("src-tauri/tests/fixtures/projects/sample.json", "{}");
    const report = repo.reconcile(t);
    expect(report.produces[0]).toMatchObject({ produced: true, evidence: "git" });
    expect(report.missing).toEqual([]);
    expect(report.outcome).toBe("ok");
  });

  it("t#1129: a directory declared with a trailing slash matches files written under it", () => {
    const t = repo.stepBase(task({ produces: ["pristine/exec-ledger/"] }));
    repo.write("pristine/exec-ledger/run-1/ledger.json", "[]");
    repo.write("pristine/exec-ledger/run-1/summary.md", "# ok");
    const report = repo.reconcile(t);
    expect(report.produces[0]).toMatchObject({ produced: true, evidence: "git" });
    expect(report.outcome_reason).toBe("ok");
  });

  it("t#1130: a produces path outside the repo counts when its mtime falls inside the attempt window", () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "cu-missing-outside-"));
    try {
      const ledger = path.join(outside, "exec-ledger", "ledger.json");
      const t = repo.stepBase(task({ produces: [ledger] }));
      const started = new Date(Date.now() - 60000);
      repo.bindSessionStart(t, "codex-thread-1", started.toISOString());
      repo.write(ledger, "[]");
      const report = repo.reconcile(t);
      expect(report.produces[0]).toMatchObject({ produced: true, evidence: "mtime" });
      expect(report.outcome).toBe("ok");

      const stale = new Date(started.getTime() - 3600000);
      utimesSync(ledger, stale, stale);
      const again = repo.reconcile(t);
      expect(again.produces[0]).toMatchObject({ produced: false, evidence: null });
      expect(again.outcome_reason).toBe(`missing:${ledger}`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("missing produces under a tracked-only snapshot", () => {
  let repo;
  beforeAll(() => {
    repo = initRepo();
    for (let i = 0; i <= UNTRACKED_SNAPSHOT_LIMIT; i += 1) repo.write(path.join("bulk", `untracked-${i}.txt`), "existing");
  }, 120000);
  afterAll(() => repo.close());

  it("t#1189: a tracked-only snapshot still sees the produces file the step created", () => {
    const t = repo.stepBase(task({ produces: ["out/ledger.json"] }));
    repo.write("out/ledger.json", "[]");
    const report = repo.reconcile(t);
    expect(report.produces[0]).toMatchObject({ produced: true, evidence: "git" });
    expect(report.outcome).toBe("ok");
  }, 60000);

  it("t#1191: a tracked-only snapshot still sees files created under a declared directory", () => {
    const t = repo.stepBase(task({ id: "worker-dir", number: 2, produces: ["pristine/exec-ledger/"] }));
    repo.write("pristine/exec-ledger/run-2/ledger.json", "[]");
    const report = repo.reconcile(t);
    expect(report.produces[0]).toMatchObject({ produced: true, evidence: "git" });
    expect(report.outcome).toBe("ok");
  }, 60000);
});
