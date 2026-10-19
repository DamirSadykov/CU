import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { saveAgentConfig } from "../agents/agents.mjs";
import { load, save } from "../kernel/board-io.mjs";
import { executeReview } from "./run-step.mjs";
import { runChange, runRecordOf } from "./run.mjs";

const mutation = {
  levels: [0, 1],
  killed: 4,
  survived: [{
    file: "src/math.ts", line: 7, column: 3, mutator: "ArithmeticOperator",
    replacement: "a - b", selector: "src/math.ts:7:2-7:7",
  }],
  noCoverage: [{
    file: "src/unused.ts", line: 11, column: 1, mutator: "BooleanLiteral",
    replacement: "false", selector: "src/unused.ts:11:0-11:4",
  }],
  quarantined: [],
  duration_ms: 23,
  status: "pass",
  reason: null,
};

const FAKE_REVIEWER = `
import { readFileSync, writeFileSync } from "node:fs";
let prompt = "";
try { prompt = readFileSync(0, "utf8"); } catch {}
writeFileSync(process.env.FAKE_PROMPT, prompt);
const argv = process.argv.slice(2);
const at = (flag) => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : ""; };
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "No findings.\\nVERDICT: approve", session_id: at("--session-id"), total_cost_usd: 0.01 }) + "\\n");
`;

let tmp;
let previousAppData;
let previousPrompt;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "run-mutation-"));
  previousAppData = process.env.APPDATA;
  previousPrompt = process.env.FAKE_PROMPT;
  process.env.APPDATA = tmp;
});

afterEach(() => {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  if (previousPrompt === undefined) delete process.env.FAKE_PROMPT;
  else process.env.FAKE_PROMPT = previousPrompt;
});

describe("step mutation integration", () => {
  it("puts survived and no-coverage mutant facts in the live reviewer prompt", async () => {
    const fake = path.join(tmp, "fake-reviewer.mjs");
    const promptFile = path.join(tmp, "prompt.txt");
    writeFileSync(fake, FAKE_REVIEWER);
    process.env.FAKE_PROMPT = promptFile;
    saveAgentConfig({
      version: 5,
      duties: { review: { mode: "agent", provider: "anthropic", model: "claude-opus-5-5", role: "reviewer" } },
      routes: {},
    });

    const result = await executeReview({
      task: { id: "id-2", number: 2, subject: "mutation prompt", produces: ["src/math.ts"], verify: "npm test" },
      workerResult: "implemented",
      mutation,
      cwd: tmp,
      claudeBin: [process.execPath, fake],
      bind: false,
    });

    expect(result).toMatchObject({ ok: true, approved: true });
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("MUTATION CHECK (non-blocking facts");
    expect(prompt).toContain("src/math.ts:7:3");
    expect(prompt).toContain("mutator=ArithmeticOperator");
    expect(prompt).toContain("selector=src/math.ts:7:2-7:7");
    expect(prompt).toContain("NO-COVERAGE MUTANTS:");
    expect(prompt).toContain("src/unused.ts:11:1");
  });

  it("runs the non-blocking gate before review and records the same result in events and runs", async () => {
    let reviewArgs;
    const effects = {
      stepBase: async () => ({ ok: true, sha: "base" }),
      executeStep: async () => ({ ok: true, sessionId: "worker-session", result: "done" }),
      recordHandoff: async () => ({ written: false }),
      stepCost: async () => 0,
      priorChanges: async () => ({ ok: true, changes: null }),
      ownChanges: async () => ({ ok: true, skip: true }),
      mutationGate: async ({ task, cwd, timeoutMs }) => {
        expect(task.number).toBe(2);
        expect(cwd).toBe(tmp);
        expect(timeoutMs).toBe(321);
        return mutation;
      },
      reviewStep: async (args) => {
        reviewArgs = args;
        return { ok: true, approved: true, costUsd: 0 };
      },
      runVerify: async () => ({ code: 0, stdout: "", stderr: "" }),
      reconcile: async () => ({ outcome: "ok", outcome_reason: "verified" }),
      setStatus: async () => {},
      recordAttempt: async () => ({ written: true, snapshot: null }),
      recordIssue: async () => ({ written: true }),
      createReviewFinding: async () => ({ written: true }),
    };
    const data = {
      version: 3,
      changes: [{ id: "change-1", number: 1, subject: "plan", status: "queue", depends_on: ["id-2"] }],
      todos: [{
        id: "id-2", number: 2, subject: "step", status: "queue", kind: "auto",
        change_id: "change-1", produces: ["src/math.ts"], verify: "npm test", retry_limit: 1,
      }],
    };

    const report = await runChange({ data, change: "1", effects, dry: false, cwd: tmp, timeoutMs: 321, history: [] });

    expect(reviewArgs.mutation).toEqual(mutation);
    expect(report.complete).toBe(true);
    expect(report.board.todos.find((task) => task.number === 2)?.status).toBe("done");
    expect(report.steps[0].mutation).toEqual(mutation);
    expect(runRecordOf(report).steps[0].mutation).toEqual(mutation);
    const events = readFileSync(path.join(tmp, "com.cu.app", "run-events.jsonl"), "utf8")
      .trim().split(/\r?\n/).map(JSON.parse);
    expect(events).toContainEqual(expect.objectContaining({ kind: "mutation", task: "t#2", status: "pass", survived: mutation.survived }));
  });

  it("round-trips task and change mutation only below ext.process", () => {
    const file = path.join(tmp, "board", "todos.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const data = {
      version: 3,
      todos: [{ id: "id-2", number: 2, subject: "step", status: "review", mutation }],
      changes: [{ id: "change-1", number: 1, subject: "plan", status: "queue", mutation }],
    };

    save(file, data);
    const wire = JSON.parse(readFileSync(file, "utf8"));
    expect(wire.todos[0]).not.toHaveProperty("mutation");
    expect(wire.todos[0].ext.process.mutation).toEqual(mutation);
    expect(wire.changes[0]).not.toHaveProperty("mutation");
    expect(wire.changes[0].ext.process.mutation).toEqual(mutation);

    const reread = load(file);
    expect(reread.todos[0].mutation).toEqual(mutation);
    expect(reread.changes[0].mutation).toEqual(mutation);
  });
});
