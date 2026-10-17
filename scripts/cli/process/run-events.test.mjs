import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERIFY_LOG_LIMIT, appendRunEvent, createVerifyLog, formatRunEvent, watchRunEvents } from "./run-events.mjs";
import { ATTEMPT_END_DETAIL_LIMIT, ATTEMPT_END_REASONS, applyResult, beginStep, buildRunContext, emitRunEvent, eventFindings, findingFile, finishStep, runChange, runStartEvent, workerSessionAnnouncer } from "./run.mjs";
import { executeStep } from "./run-step.mjs";
import { saveAgentConfig } from "../agents/agents.mjs";

describe("run events", () => {
  it("appends JSON lines and formats a review", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "run-events-"));
    const file = path.join(dir, "run-events.jsonl");
    try {
      expect(appendRunEvent({ run: "r1", change: 62, task: 790, kind: "review", attempt: 2, limit: 3, counts: { high: 1, medium: 0 } }, file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ run: "r1", change: 62, task: 790, kind: "review" });
      expect(formatRunEvent({ change: 62, task: 790, kind: "review", attempt: 2, limit: 3, counts: { high: 1, medium: 0 } })).toBe("p#62 t#790 attempt 2/3: review high 1, medium 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("watches one change and ends on park", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "run-events-"));
    const file = path.join(dir, "run-events.jsonl");
    const lines = [];
    try {
      const watching = watchRunEvents({ change: "c#62", file, from: "start", onLine: (line) => lines.push(line) });
      appendRunEvent({ change: 99, task: 1, kind: "review", counts: { high: 1 } }, file);
      appendRunEvent({ change: 62, task: 790, kind: "park", park_kind: "retry", reason: "spent" }, file);
      await watching;
      expect(lines).toEqual(["p#62 t#790: park retry — spent"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays from the latest run start of the change, not from an older run's park", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "run-events-"));
    const file = path.join(dir, "run-events.jsonl");
    const lines = [];
    try {
      appendRunEvent({ change: 62, kind: "run_start" }, file);
      appendRunEvent({ change: 62, task: 790, kind: "park", park_kind: "retry", reason: "old" }, file);
      appendRunEvent({ change: 62, kind: "run_start" }, file);
      appendRunEvent({ change: 62, task: 791, kind: "step_start", attempt: 1, limit: 2 }, file);
      appendRunEvent({ change: 99, kind: "run_start" }, file);
      const watching = watchRunEvents({ change: "c#62", file, from: "start", onLine: (line) => lines.push(line) });
      appendRunEvent({ change: 62, kind: "run_end" }, file);
      await watching;
      expect(lines).toEqual(["p#62: run start", "p#62 t#791 attempt 1/2: step start", "p#62: run end"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const WORKER_SESSION_FIELDS = {
  ts: "string",
  run: "string",
  change: "string",
  task: "string",
  kind: "string",
  attempt: "number",
  engine: "string",
  session: "string",
  cwd: "string",
  transcript: "string",
};

const V2_FIELDS = {
  run_start: { parallel: ["number"], steps: ["array"] },
  step_start: { base: ["string"] },
  worker_done: { fallback: ["array"], inherit_dropped: ["boolean"], guard: ["string"] },
  review: { verdict: ["string"], findings: ["array"], fallback: ["array"], guard: ["string"] },
  attempt_snapshot: { attempt: ["number"], snapshot: ["string"] },
  verify: { log: ["string"] },
  park: { attempts: ["array"] },
  warning: { warning: ["string"], write: ["number"], retrying: ["boolean"], error: ["string"] },
  attempt_end: {
    task: ["string"],
    attempt: ["number"],
    limit: ["number", "null"],
    outcome: ["string"],
    reason: ["string"],
    detail: ["string"],
    paths: ["array", "undefined"],
  },
};

const ATTEMPT_END_OUTCOMES = ["retry", "park"];

const ATTEMPT_END_REASON_SET = [
  "review",
  "worker_error",
  "timeout",
  "reverted",
  "red",
  "flow",
  "flow_cannot",
  "verify",
  "missing_produces",
  "reconcile",
  "mechanics",
  "undecided",
  "interrupted",
];

const STEP_FIELDS = { task: ["string"], subject: ["string"], kind: ["string"], needs: ["array"] };

const FINDING_FIELDS = { level: ["string"], file: ["string", "null"], line: ["number", "null"], text: ["string"], evidence: ["string", "null"] };
const PARK_ATTEMPT_FIELDS = { attempt: ["number"], reason: ["string", "null"], cost_usd: ["number", "null"], verify: ["string", "null"], ended_at: ["string", "null"] };

const typeOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

function expectFields(object, fields, label) {
  for (const [field, types] of Object.entries(fields)) expect(types, `${label}.${field}`).toContain(typeOf(object[field]));
}

function expectV2Event(event) {
  const fields = V2_FIELDS[event.kind];
  if (!fields) return;
  expectFields(event, fields, event.kind);
  if (event.kind === "run_start") {
    expect(Number.isInteger(event.parallel) && event.parallel >= 1).toBe(true);
    for (const step of event.steps) {
      expectFields(step, STEP_FIELDS, "steps[]");
      expect(step.task).toMatch(/^t#\d+$/);
      expect(["auto", "manual"]).toContain(step.kind);
      for (const need of step.needs) expect(need).toMatch(/^t#\d+$/);
    }
  }
  if (event.kind === "review") {
    expect(["approve", "issue"]).toContain(event.verdict);
    for (const finding of event.findings) {
      expectFields(finding, FINDING_FIELDS, "findings[]");
      expect(finding.file === null).toBe(finding.line === null);
      if (finding.file !== null) {
        expect(finding.file).not.toMatch(/\\|^\.\/|^\/|^[A-Za-z]:/);
        expect(Number.isInteger(finding.line) && finding.line >= 1).toBe(true);
      }
    }
  }
  if (event.kind === "attempt_snapshot") expect(event.snapshot).toMatch(/^[0-9a-f]{40}$/);
  if (event.kind === "park") for (const attempt of event.attempts) expectFields(attempt, PARK_ATTEMPT_FIELDS, "park.attempts[]");
  if (event.kind === "attempt_end") {
    expect(event.task).toMatch(/^t#\d+$/);
    expect(Number.isInteger(event.attempt) && event.attempt >= 1).toBe(true);
    expect(ATTEMPT_END_OUTCOMES).toContain(event.outcome);
    expect(ATTEMPT_END_REASON_SET).toContain(event.reason);
    expect(event.detail.length).toBeLessThanOrEqual(2000);
    if (event.paths !== undefined) {
      expect(event.paths.length).toBeGreaterThan(0);
      for (const p of event.paths) expect(p).not.toMatch(/\\|^\.\/|^\/|^[A-Za-z]:|^\.\.\//);
    }
  }
}

const ENGINES = ["claude", "codex"];

const FAKE_CLAUDE = `
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ""; };
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: at("--session-id"), total_cost_usd: 0.01, num_turns: 1 }) + "\\n");
`;

const CODEX_THREAD = "019a0000-0000-7000-8000-00000000c0de";

const FAKE_CODEX = `
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "${CODEX_THREAD}" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }) + "\\n");
`;

const CONTRACT_HOME = "C:\\Users\\contract";
const BASE_SHA = "ba5e000000000000000000000000000000000001";
const snapshotOf = (task, attempt) => `5a0${task}${attempt}`.padEnd(40, "0");
const CLAUDE_SESSION = "00000000-0000-4000-8000-0000000c1a0d";
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "run-events-contract.jsonl");

function expectWorkerSession(event, { local = true } = {}) {
  for (const [field, type] of Object.entries(WORKER_SESSION_FIELDS)) {
    expect(typeof event[field], field).toBe(type);
    if (type === "string") expect(event[field].length, field).toBeGreaterThan(0);
  }
  expect(event.kind).toBe("worker_session");
  expect(ENGINES).toContain(event.engine);
  expect(event.change).toMatch(/^c#\d+$/);
  expect(event.task).toMatch(/^t#\d+$/);
  expect(Number.isInteger(event.attempt) && event.attempt >= 1).toBe(true);
  expect(event.transcript.endsWith(".jsonl")).toBe(true);
  if (local) {
    expect(path.isAbsolute(event.cwd)).toBe(true);
    expect(path.isAbsolute(event.transcript)).toBe(true);
  }
}

describe("worker_session contract", () => {
  let tmp;
  const saved = {};
  const env = ["APPDATA", "USERPROFILE", "HOME", "CODEX_HOME", "CLAUDE_CODE_SESSION_ID"];

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "worker-session-"));
    for (const key of env) saved[key] = process.env[key];
    process.env.APPDATA = tmp;
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  afterEach(() => {
    for (const key of env) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("emits a park with attempts for every stopped node in one wave", async () => {
    const attempt = (reason) => ({ attempt: 1, reason, cost_usd: 0.1, verify: null, ended_at: "2026-10-13T12:00:00Z" });
    const data = { version: 3, todos: [
      { id: "root", number: 90, subject: "change", status: "queue", change: true, depends_on: ["a", "b"] },
      { id: "a", number: 1, subject: "a", status: "queue", kind: "auto", verify: "test", attempts: [attempt("mechanics")] },
      { id: "b", number: 2, subject: "b", status: "queue", kind: "auto", verify: "test", attempts: [attempt("mechanics")] },
    ] };
    const ctx = buildRunContext({ data, change: 90, dry: false, events: true, spent: 0, effects: { setStatus: async () => {} } });
    for (const task of ctx.members) await applyResult(ctx, {
      task, kind: "mechanics", attempt: 1, limit: 1, cost: 0.1, reason: `crashed ${task.number}`, endReason: "mechanics",
    }, { dry: false, log: () => {} });

    const file = path.join(tmp, "com.cu.app", "run-events.jsonl");
    const parks = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).filter((event) => event.kind === "park");
    expect(parks.map((event) => event.task)).toEqual(["t#1", "t#2"]);
    expect(parks.map((event) => event.attempts[0].reason)).toEqual(["mechanics", "mechanics"]);
  });

  async function emitRun() {
    const work = path.join(tmp, "work");
    mkdirSync(work, { recursive: true });
    const fakeClaude = path.join(tmp, "fake-claude.mjs");
    const fakeCodex = path.join(tmp, "fake-codex.mjs");
    writeFileSync(fakeClaude, FAKE_CLAUDE);
    writeFileSync(fakeCodex, FAKE_CODEX);
    const rolloutDir = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "12");
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(path.join(rolloutDir, `rollout-2026-10-12T10-00-00-${CODEX_THREAD}.jsonl`), "");
    const root = { id: "id-98", number: 98, subject: "contract", status: "queue", change: true, depends_on: ["id-1", "id-2", "id-3"] };
    const data = {
      version: 2,
      todos: [
        root,
        { id: "id-1", number: 1, subject: "claude step", status: "queue", kind: "auto", verify: "npm test", retry_limit: 2 },
        { id: "id-2", number: 2, subject: "codex step", status: "queue", kind: "auto", verify: "npm test", retry_limit: 2, produces: ["src/b.ts"] },
        { id: "id-3", number: 3, subject: "manual check", status: "queue", kind: "manual", depends_on: ["id-1", "id-2"] },
      ],
    };
    mkdirSync(path.join(tmp, "com.cu.app"), { recursive: true });
    writeFileSync(path.join(tmp, "com.cu.app", "todos.json"), JSON.stringify(data));
    const verifyCodes = { 1: 0, 2: 1 };
    let current = 1;
    const ctx = buildRunContext({
      data,
      change: 98,
      dry: false,
      events: true,
      cwd: work,
      timeoutMs: 30000,
      effects: {
        setStatus: async () => {},
        stepBase: async () => ({ ok: true, sha: BASE_SHA }),
        priorChanges: async () => ({ ok: true }),
        recordIssue: async () => ({ written: true }),
        recordAttempt: async ({ task, entry }) => ({ written: true, snapshot: snapshotOf(task.number, entry.attempt) }),
        runVerify: async ({ onOutput }) => {
          onOutput?.(Buffer.from("verify stdout\n"));
          onOutput?.(Buffer.from("verify stderr\n"));
          return { code: verifyCodes[current], stdout: "verify stdout\n", stderr: "verify stderr\n" };
        },
        reconcile: async ({ verify }) => ({ outcome: verify === "ok" ? "ok" : "issue", outcome_reason: `verify:${verify}` }),
      },
    });
    ctx.runId = "contract-run";
    const claudeStep = ctx.byId.get("id-1");
    const codexStep = ctx.byId.get("id-2");
    emitRunEvent(ctx, runStartEvent(ctx, 2));
    const claudeBegun = await beginStep(ctx, claudeStep);
    const claude = await executeStep({
      ...claudeBegun.brief,
      bind: false,
      claudeBin: [process.execPath, fakeClaude],
      onSession: workerSessionAnnouncer(ctx, claudeStep, claudeBegun.attempt),
    });
    expect(claude.ok).toBe(true);
    emitRunEvent(ctx, { task: 1, kind: "worker_done", attempt: 1, limit: 2, cost: 0.01, fallback: claude.fallback, inherit_dropped: claude.inherit_dropped, guard: claude.guard });
    const claudeReview = {
      approved: true,
      ok: true,
      findings: [
        { level: "medium", file: path.join(work, "src", "app.ts"), line: 12, text: "absolute path inside the repository", evidence: "a reload drops the filter" },
        { level: "low", file: "./src/util.ts", line: 3, text: "dot-relative path", evidence: null },
        { level: "low", file: path.join(tmp, "elsewhere.ts"), line: 1, text: "path outside the repository", evidence: null },
      ],
    };
    const claudeDone = await finishStep(ctx, claudeStep, { result: claude, review: claudeReview, baton: null, cost: 0.01, ownChanges: null, outsideChanges: null });
    expect(claudeDone.kind).toBe("done");
    await applyResult(ctx, claudeDone, { dry: false, log: () => {} });
    current = 2;
    saveAgentConfig({ version: 2, duties: { worker: { provider: "openai", model: "gpt-5.6-terra", role: "worker" } } });
    const codexBegun = await beginStep(ctx, codexStep);
    const codex = await executeStep({
      ...codexBegun.brief,
      bind: false,
      codexBin: [process.execPath, fakeCodex],
      onSession: workerSessionAnnouncer(ctx, codexStep, codexBegun.attempt),
    });
    expect(codex.ok).toBe(true);
    emitRunEvent(ctx, { task: 2, kind: "worker_done", attempt: 1, limit: 2, cost: 0.002, fallback: codex.fallback, inherit_dropped: codex.inherit_dropped, guard: codex.guard });
    const codexReview = {
      approved: false,
      ok: true,
      findings: [{ level: "high", file: "src/b.ts", line: 7, text: "the obligation is unmet", evidence: "saving twice keeps the stale row" }],
    };
    const codexIssue = await finishStep(ctx, codexStep, { result: codex, review: codexReview, baton: null, cost: 0.002, ownChanges: null, outsideChanges: null });
    expect(codexIssue.kind).toBe("issue");
    await applyResult(ctx, codexIssue, { dry: false, log: () => {} });
    const codexRetry = await beginStep(ctx, codexStep);
    expect(codexRetry.attempt).toBe(2);
    emitRunEvent(ctx, { task: 2, kind: "worker_done", attempt: 2, limit: 2, cost: 0.002, fallback: codex.fallback, inherit_dropped: codex.inherit_dropped, guard: codex.guard });
    const codexFailed = await finishStep(ctx, codexStep, { result: codex, review: { approved: true, ok: true, findings: [] }, baton: null, cost: 0.002, ownChanges: null, outsideChanges: null });
    expect(codexFailed.verify).toBe("issue");
    await applyResult(ctx, codexFailed, { dry: false, log: () => {} });
    expect(ctx.stop?.kind).toBe("retry");
    emitRunEvent(ctx, { kind: "run_end", complete: false, stop: "park" });
    return {
      claudeSession: claude.sessionId,
      events: readFileSync(path.join(tmp, "com.cu.app", "run-events.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line)),
    };
  }

  it("announces each worker session with every required field and type", async () => {
    const { events, claudeSession } = await emitRun();
    const sessions = events.filter((event) => event.kind === "worker_session");
    expect(sessions.map((event) => event.engine)).toEqual(["claude", "codex"]);
    sessions.forEach((event) => expectWorkerSession(event));
    expect(sessions[0]).toMatchObject({
      run: "contract-run", change: "c#98", task: "t#1", attempt: 1, session: claudeSession, cwd: path.join(tmp, "work"),
    });
    expect(sessions[0].transcript).toBe(
      path.join(tmp, ".claude", "projects", path.join(tmp, "work").replace(/[\\/:]/g, "-"), `${claudeSession}.jsonl`),
    );
    expect(sessions[1]).toMatchObject({ task: "t#2", attempt: 1, session: CODEX_THREAD });
    expect(sessions[1].transcript.startsWith(path.join(process.env.CODEX_HOME, "sessions"))).toBe(true);
    const start = events.findIndex((event) => event.kind === "step_start" && event.task === "t#1");
    const done = events.findIndex((event) => event.kind === "worker_done" && event.task === "t#1");
    const announced = events.indexOf(sessions[0]);
    expect(start < announced && announced < done).toBe(true);
    expect(formatRunEvent(sessions[1])).toBe(`p#98 t#2 attempt 1/-: worker session codex ${CODEX_THREAD}`);
  });

  it("carries the v2 fields with their types on every event that has them", async () => {
    const { events } = await emitRun();
    events.forEach(expectV2Event);
    const start = events.find((event) => event.kind === "run_start");
    expect(start.parallel).toBe(2);
    expect(start.steps).toEqual([
      { task: "t#1", subject: "claude step", kind: "auto", needs: [] },
      { task: "t#2", subject: "codex step", kind: "auto", needs: [] },
      { task: "t#3", subject: "manual check", kind: "manual", needs: ["t#1", "t#2"] },
    ]);
    expect(events.filter((event) => event.kind === "step_start").map((event) => [event.task, event.attempt, event.base])).toEqual([
      ["t#1", 1, BASE_SHA], ["t#2", 1, BASE_SHA], ["t#2", 2, BASE_SHA],
    ]);
    const reviews = events.filter((event) => event.kind === "review");
    expect(reviews.map((event) => [event.task, event.attempt, event.verdict])).toEqual([
      ["t#1", 1, "approve"], ["t#2", 1, "issue"], ["t#2", 2, "approve"],
    ]);
    expect(reviews[0].findings).toEqual([
      { level: "medium", file: "src/app.ts", line: 12, text: "absolute path inside the repository", evidence: "a reload drops the filter", scope: "out" },
      { level: "low", file: "src/util.ts", line: 3, text: "dot-relative path", evidence: null, scope: "out" },
      { level: "low", file: null, line: null, text: "path outside the repository", evidence: null, scope: "out" },
    ]);
    expect(reviews[1].findings).toEqual([
      { level: "high", file: "src/b.ts", line: 7, text: "the obligation is unmet", evidence: "saving twice keeps the stale row", scope: "in" },
    ]);
    const verifies = events.filter((event) => event.kind === "verify");
    expect(verifies.map((event) => [event.task, event.attempt, event.ok])).toEqual([["t#1", 1, true], ["t#2", 2, false]]);
    for (const event of verifies) {
      expect(event.log).toBe(path.join(tmp, "com.cu.app", "run-logs", "contract-run", `${event.task.replace("#", "")}-a${event.attempt}-verify.log`));
      expect(readFileSync(event.log, "utf8")).toBe("verify stdout\nverify stderr\n");
    }
  });

  it("ends every attempt it does not accept with attempt_end, after its review and verify and before the next start or park", async () => {
    const { events } = await emitRun();
    const ends = events.filter((event) => event.kind === "attempt_end");
    expect(ends.map((event) => [event.task, event.attempt, event.limit, event.outcome, event.reason])).toEqual([
      ["t#2", 1, 2, "retry", "review"],
      ["t#2", 2, 2, "park", "verify"],
    ]);
    expect(ends[0].detail.startsWith("model review issue: ")).toBe(true);
    expect(ends[1].detail).toBe("verify:issue");
    for (const end of ends) expect(end).not.toHaveProperty("paths");
    const at = (kind, attempt) => events.findIndex((event) => event.kind === kind && event.task === "t#2" && event.attempt === attempt);
    expect(at("review", 1)).toBeLessThan(events.indexOf(ends[0]));
    expect(events.indexOf(ends[0])).toBeLessThan(at("step_start", 2));
    expect(at("verify", 2)).toBeLessThan(events.indexOf(ends[1]));
    expect(events.indexOf(ends[1]) + 1).toBe(events.findIndex((event) => event.kind === "park"));
    expect(formatRunEvent(ends[0])).toBe(`p#98 t#2 attempt 1/2: attempt end retry (review) — ${ends[0].detail}`);
    const parked = events.find((event) => event.kind === "park" && event.task === "t#2");
    expect(parked.attempts).toEqual([
      expect.objectContaining({ attempt: 1, reason: "review", cost_usd: 0.002, verify: null }),
      expect.objectContaining({ attempt: 2, reason: "verify", cost_usd: 0.002, verify: "issue" }),
    ]);
    parked.attempts.forEach((attempt) => expect(attempt.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/));
  });

  it("documents exactly the reasons the runner can emit", () => {
    expect([...ATTEMPT_END_REASONS].sort()).toEqual([...ATTEMPT_END_REASON_SET].sort());
    expect(ATTEMPT_END_DETAIL_LIMIT).toBe(2000);
  });

  it("appends attempt_snapshot when each attempt is recorded", async () => {
    const { events } = await emitRun();
    const snapshots = events.filter((event) => event.kind === "attempt_snapshot");
    expect(snapshots.map((event) => [event.task, event.attempt, event.snapshot])).toEqual([
      ["t#1", 1, snapshotOf(1, 1)], ["t#2", 1, snapshotOf(2, 1)], ["t#2", 2, snapshotOf(2, 2)],
    ]);
    for (const snapshot of snapshots) {
      const at = events.indexOf(snapshot);
      const review = events.findIndex((event) => event.kind === "review" && event.task === snapshot.task && event.attempt === snapshot.attempt);
      expect(review >= 0 && review < at).toBe(true);
    }
    expect(formatRunEvent(snapshots[0])).toBe(`p#98 t#1 attempt 1/-: snapshot ${snapshotOf(1, 1).slice(0, 12)}`);
  });

  async function verifyOnce({ output = "", snapshot = null } = {}) {
    const step = { id: "id-5", number: 5, subject: "big verify", status: "queue", kind: "auto", verify: "npm test", retry_limit: 1 };
    const data = { version: 2, todos: [{ id: "id-90", number: 90, subject: "big", status: "queue", change: true, depends_on: ["id-5"] }, step] };
    const ctx = buildRunContext({
      data,
      change: 90,
      dry: false,
      events: true,
      cwd: tmp,
      effects: {
        setStatus: async () => {},
        stepBase: async () => ({ ok: false, error: "no git" }),
        priorChanges: async () => ({ ok: true }),
        recordIssue: async () => ({ written: true }),
        recordAttempt: async () => ({ written: true, snapshot }),
        runVerify: async ({ onOutput }) => {
          for (let i = 0; i < output.length; i += 64 * 1024) onOutput(Buffer.from(output.slice(i, i + 64 * 1024)));
          return { code: 0, stdout: "", stderr: "" };
        },
        reconcile: async () => ({ outcome: "ok" }),
      },
    });
    ctx.runId = "big-run";
    ctx.stepBaseWarned = true;
    const task = ctx.byId.get("id-5");
    await beginStep(ctx, task);
    await finishStep(ctx, task, { result: { ok: true }, review: null, baton: null, cost: null, ownChanges: null, outsideChanges: null });
    return readFileSync(path.join(tmp, "com.cu.app", "run-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  }

  it("caps the verify log at 1 MB, cutting from the start and saying how many bytes were dropped", async () => {
    const lines = Array.from({ length: 40000 }, (_, i) => `line ${String(i).padStart(6, "0")} ${"x".repeat(30)}\n`);
    const output = lines.join("");
    expect(Buffer.byteLength(output)).toBeGreaterThan(VERIFY_LOG_LIMIT);
    const events = await verifyOnce({ output });
    const verify = events.find((event) => event.kind === "verify");
    expect(verify.log).toBe(path.join(tmp, "com.cu.app", "run-logs", "big-run", "t5-a1-verify.log"));
    const written = readFileSync(verify.log);
    expect(written.length).toBeLessThanOrEqual(VERIFY_LOG_LIMIT);
    const text = written.toString("utf8");
    const header = text.slice(0, text.indexOf("\n") + 1);
    const dropped = Number(/^\[verify log truncated: (\d+) bytes dropped from the start\]\n$/.exec(header)?.[1]);
    expect(dropped).toBe(Buffer.byteLength(output) - (written.length - Buffer.byteLength(header)));
    expect(output.endsWith(text.slice(header.length))).toBe(true);
    expect(text.endsWith(lines.at(-1))).toBe(true);
    expect(events.some((event) => event.kind === "attempt_snapshot")).toBe(false);
  });

  it("appends attempt_snapshot only when the attempt has a snapshot", async () => {
    const events = await verifyOnce({ output: "ok\n", snapshot: "c0ffee0000000000000000000000000000000000" });
    expect(events.filter((event) => event.kind === "attempt_snapshot")).toEqual([
      expect.objectContaining({ run: "big-run", change: "c#90", task: "t#5", attempt: 1, snapshot: "c0ffee0000000000000000000000000000000000" }),
    ]);
    const verify = events.find((event) => event.kind === "verify");
    expect(readFileSync(verify.log, "utf8")).toBe("ok\n");
    expect(events.find((event) => event.kind === "step_start")).not.toHaveProperty("base");
  });

  it("writes the shared contract fixture from the real emitter", async () => {
    const { events, claudeSession } = await emitRun();
    const forms = [tmp, tmp.replace(/\\/g, "/")];
    const slug = (p) => p.replace(/[\\/:]/g, "-");
    const clean = (value) => {
      if (typeof value !== "string") return value;
      let out = value.split(claudeSession).join(CLAUDE_SESSION);
      out = out.split(slug(tmp)).join(slug(CONTRACT_HOME));
      for (const form of forms) out = out.split(form).join(CONTRACT_HOME);
      return out.startsWith(CONTRACT_HOME) ? out.replace(/\//g, "\\") : out;
    };
    const lines = events.map((event, i) => {
      const out = {};
      for (const [key, value] of Object.entries(event)) out[key] = key === "change" || key === "task" || key === "kind" ? value : clean(value);
      if (event.kind === "park") out.attempts = out.attempts.map((attempt, j) => ({
        ...attempt,
        ended_at: new Date(Date.UTC(2026, 9, 12, 9, 59, j)).toISOString(),
      }));
      out.ts = new Date(Date.UTC(2026, 9, 12, 10, 0, i)).toISOString();
      return JSON.stringify(out);
    });
    const parsed = lines.map((line) => JSON.parse(line));
    parsed.filter((event) => event.kind === "worker_session").forEach((event) => expectWorkerSession(event, { local: false }));
    expect(parsed.filter((event) => event.kind === "worker_session").map((event) => event.transcript)).toEqual([
      `${CONTRACT_HOME}\\.claude\\projects\\${slug(`${CONTRACT_HOME}\\work`)}\\${CLAUDE_SESSION}.jsonl`,
      `${CONTRACT_HOME}\\.codex\\sessions\\2026\\10\\12\\rollout-2026-10-12T10-00-00-${CODEX_THREAD}.jsonl`,
    ]);
    parsed.forEach(expectV2Event);
    mkdirSync(path.dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, `${lines.join("\n")}\n`);
    const fixture = readFileSync(FIXTURE, "utf8");
    expect(fixture).not.toContain(path.basename(tmp));
    for (const marker of ['"attempt_snapshot"', '"base"', '"findings"', '"steps"', '"parallel"', '"log"', '"attempt_end"', '"attempts"']) expect(fixture).toContain(marker);
  });
});

describe("attempt_end causes", () => {
  let tmp;
  const saved = {};
  const env = ["APPDATA", "USERPROFILE", "HOME", "CODEX_HOME", "CLAUDE_CODE_SESSION_ID"];

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "attempt-end-"));
    for (const key of env) saved[key] = process.env[key];
    process.env.APPDATA = tmp;
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  afterEach(() => {
    for (const key of env) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  async function runWith({ retryLimit = 2, attempts }) {
    const step = { id: "id-7", number: 7, subject: "step", status: "queue", kind: "auto", verify: "npm test", retry_limit: retryLimit, produces: ["docs/x.md"] };
    const data = { version: 2, todos: [{ id: "id-70", number: 70, subject: "change", status: "queue", change: true, depends_on: ["id-7"] }, step] };
    let n = 0;
    const current = () => attempts[Math.min(n, attempts.length) - 1] || {};
    const report = await runChange({
      data,
      change: 70,
      dry: false,
      cwd: tmp,
      history: [],
      effects: {
        executeStep: async () => {
          n += 1;
          const plan = current();
          if (plan.throws) throw new Error(plan.throws);
          return plan.result || { ok: true, sessionId: `s-${n}`, result: "done" };
        },
        stepCost: async () => 0.01,
        recordHandoff: async () => ({ written: true }),
        setStatus: async () => {},
        recordIssue: async () => ({ written: true }),
        recordAttempt: async () => ({ written: true, snapshot: null }),
        stepBase: async () => ({ ok: true, sha: BASE_SHA }),
        priorChanges: async () => ({ ok: true, changes: null }),
        ownChanges: async () => ({ ok: true, own: [], outside: [], damaged: current().damaged || [] }),
        reviewContext: async () => null,
        reviewStep: async () => ({ approved: true, ok: true, findings: [] }),
        runVerify: async () => {
          if (current().verifyThrows) throw new Error(current().verifyThrows);
          return { code: 0, stdout: "ok\n", stderr: "" };
        },
        reconcile: async () => {
          if (current().reconcileThrows) throw new Error(current().reconcileThrows);
          return current().reconcile || { outcome: "ok", outcome_reason: "ok" };
        },
      },
    });
    const events = readFileSync(path.join(tmp, "com.cu.app", "run-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    events.forEach(expectV2Event);
    return { report, events, ends: events.filter((event) => event.kind === "attempt_end") };
  }

  it("names reverted neighbour work with its paths on a retry, and missing produces on a park", async () => {
    const { report, events, ends } = await runWith({
      attempts: [
        { damaged: [{ path: "src/a.ts", state: "reverted" }, { path: "src\\b.ts", state: "deleted" }] },
        { reconcile: { outcome: "issue", outcome_reason: "missing:docs/x.md", missing: ["docs/x.md"] } },
      ],
    });
    expect(ends.map((event) => [event.attempt, event.outcome, event.reason, event.paths])).toEqual([
      [1, "retry", "reverted", ["src/a.ts", "src/b.ts"]],
      [2, "park", "missing_produces", ["docs/x.md"]],
    ]);
    expect(ends[0].detail).toBe(report.transitions[0].reason);
    expect(ends[0].detail).toBe("task reverted or deleted work of earlier tasks outside its own produces: src/a.ts, src\\b.ts");
    expect(ends[1].detail).toBe("missing:docs/x.md");
    expect(events.indexOf(ends[0])).toBeLessThan(events.findIndex((event) => event.kind === "step_start" && event.attempt === 2));
    expect(events.indexOf(ends[1])).toBeLessThan(events.findIndex((event) => event.kind === "park"));
    expect(events.findIndex((event) => event.kind === "verify" && event.attempt === 2)).toBeLessThan(events.indexOf(ends[1]));
  });

  it("tells a timed-out worker from a failed one and caps the detail at 2000 characters", async () => {
    const timedOut = await runWith({
      retryLimit: 1,
      attempts: [{ result: { ok: false, timedOut: true, error: "timed out after 10ms — process tree killed" } }],
    });
    expect(timedOut.ends).toEqual([expect.objectContaining({ task: "t#7", attempt: 1, limit: 1, outcome: "park", reason: "timeout", detail: "task failed: timed out after 10ms — process tree killed" })]);
    rmSync(path.join(tmp, "com.cu.app", "run-events.jsonl"), { force: true });
    const crashed = await runWith({ retryLimit: 1, attempts: [{ throws: "x".repeat(5000) }] });
    expect(crashed.ends).toHaveLength(1);
    expect(crashed.ends[0]).toMatchObject({ outcome: "park", reason: "worker_error" });
    expect(crashed.ends[0].detail).toBe(`task failed: ${"x".repeat(5000)}`.slice(0, 2000));
  });

  it.each([
    ["verify", { verifyThrows: "verify boom" }, /runVerify crashed: verify boom/],
    ["reconcile", { reconcileThrows: "reconcile boom" }, /reconcile crashed: reconcile boom/],
  ])("parks and closes the run event stream when %s throws", async (_phase, attempt, reason) => {
    const { report, events, ends } = await runWith({ retryLimit: 1, attempts: [attempt] });
    expect(report.stop).toMatchObject({ kind: "mechanics", reason: expect.stringMatching(reason) });
    expect(ends).toEqual([expect.objectContaining({ outcome: "park", reason: "mechanics" })]);
    expect(events.at(-1)).toMatchObject({ kind: "run_end", complete: false, stop: "mechanics" });
  });

  it("emits nothing for an accepted attempt", async () => {
    const { ends, report } = await runWith({ attempts: [{}] });
    expect(report.complete).toBe(true);
    expect(ends).toEqual([]);
  });
});

describe("finding paths", () => {
  const root = path.join(os.tmpdir(), "repo-root");

  it("normalizes absolute, dot-relative and backslash paths to repo-relative with / separators", () => {
    expect(findingFile(path.join(root, "src", "a.ts"), root)).toBe("src/a.ts");
    expect(findingFile("./src/a.ts", root)).toBe("src/a.ts");
    expect(findingFile(".\\src\\a.ts", root)).toBe("src/a.ts");
    expect(findingFile("src\\nested\\b.ts", root)).toBe("src/nested/b.ts");
    expect(findingFile("src/./c/../d.ts", root)).toBe("src/d.ts");
    expect(findingFile(path.join(root, "src", "a.ts"), () => root)).toBe("src/a.ts");
  });

  it("returns null for a path outside the repository", () => {
    expect(findingFile(path.join(path.dirname(root), "other", "a.ts"), root)).toBe(null);
    expect(findingFile("../a.ts", root)).toBe(null);
    expect(findingFile("src/../../a.ts", root)).toBe(null);
    expect(findingFile(root, root)).toBe(null);
    expect(findingFile(path.join(root, "a.ts"), null)).toBe(null);
    expect(findingFile("", root)).toBe(null);
    expect(findingFile(null, root)).toBe(null);
  });

  it("keeps a finding file-less unless it has both a repo file and a 1-based line", () => {
    expect(eventFindings([
      { level: "high", file: "./src/a.ts", line: 4, text: "t", evidence: "e" },
      { level: "medium", file: "src/a.ts", line: null, text: "no line", evidence: null },
      { level: "medium", file: "src/a.ts", line: 0, text: "zero line", evidence: null },
      { level: "low", file: null, line: 9, text: "no file", evidence: null },
      { level: "low", file: path.join(path.dirname(root), "x.ts"), line: 2, text: "outside" },
    ], root)).toEqual([
      { level: "high", file: "src/a.ts", line: 4, text: "t", evidence: "e", scope: "out" },
      { level: "medium", file: null, line: null, text: "no line", evidence: null, scope: "out" },
      { level: "medium", file: null, line: null, text: "zero line", evidence: null, scope: "out" },
      { level: "low", file: null, line: null, text: "no file", evidence: null, scope: "out" },
      { level: "low", file: null, line: null, text: "outside", evidence: null, scope: "out" },
    ]);
  });
});

describe("verify log cap", () => {
  it("keeps a log under the limit as is", () => {
    const log = createVerifyLog(64);
    log.push("hello ");
    log.push(Buffer.from("world\n"));
    expect(log.bytes().toString("utf8")).toBe("hello world\n");
  });

  it("drops the start of a bigger log and names the dropped byte count on the first line", () => {
    const log = createVerifyLog(100);
    const input = Array.from({ length: 30 }, (_, i) => `row ${i}\n`).join("");
    for (const ch of input) log.push(ch);
    const out = log.bytes();
    expect(out.length).toBeLessThanOrEqual(100);
    const text = out.toString("utf8");
    const header = text.slice(0, text.indexOf("\n") + 1);
    const dropped = Number(/^\[verify log truncated: (\d+) bytes dropped from the start\]\n$/.exec(header)?.[1]);
    expect(dropped).toBe(Buffer.byteLength(input) - (out.length - header.length));
    expect(input.endsWith(text.slice(header.length))).toBe(true);
  });

  it("never starts the kept tail in the middle of a UTF-8 character", () => {
    const log = createVerifyLog(80);
    const input = "ж".repeat(200);
    log.push(input);
    const text = log.bytes().toString("utf8");
    expect(text).not.toContain("�");
    expect(text.slice(text.indexOf("\n") + 1)).toMatch(/^ж+$/);
  });

  it("defaults to 1 MB", () => {
    expect(VERIFY_LOG_LIMIT).toBe(1024 * 1024);
  });
});
