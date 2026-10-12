import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRunEvent, formatRunEvent, watchRunEvents } from "./run-events.mjs";
import { beginStep, emitRunEvent, workerSessionAnnouncer } from "./run.mjs";
import { executeStep } from "./run-step.mjs";
import { saveAgentConfig } from "../agents/agents.mjs";

describe("run events", () => {
  it("appends JSON lines and formats a review", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "run-events-"));
    const file = path.join(dir, "run-events.jsonl");
    try {
      expect(appendRunEvent({ run: "r1", change: 62, task: 790, kind: "review", attempt: 2, limit: 3, counts: { high: 1, medium: 0 } }, file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ run: "r1", change: 62, task: 790, kind: "review" });
      expect(formatRunEvent({ change: 62, task: 790, kind: "review", attempt: 2, limit: 3, counts: { high: 1, medium: 0 } })).toBe("c#62 t#790 attempt 2/3: review high 1, medium 0");
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
      expect(lines).toEqual(["c#62 t#790: park retry — spent"]);
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
      expect(lines).toEqual(["c#62: run start", "c#62 t#791 attempt 1/2: step start", "c#62: run end"]);
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
    const root = { id: "id-98", number: 98, subject: "contract", status: "queue", change: true, depends_on: ["id-1", "id-2"] };
    const claudeStep = { id: "id-1", number: 1, subject: "claude step", status: "queue", kind: "auto", verify: "npm test", retry_limit: 2 };
    const codexStep = { id: "id-2", number: 2, subject: "codex step", status: "queue", kind: "auto", verify: "npm test", retry_limit: 2 };
    const data = { version: 2, todos: [root, claudeStep, codexStep] };
    mkdirSync(path.join(tmp, "com.cu.app"), { recursive: true });
    writeFileSync(path.join(tmp, "com.cu.app", "todos.json"), JSON.stringify(data));
    const ctx = {
      attempts: new Map(), dry: false, events: true, runId: "contract-run", root, data, cwd: work, timeoutMs: 30000,
      effects: { setStatus: async () => {}, stepBase: async () => ({ ok: true, sha: "base" }), priorChanges: async () => ({ ok: true }) },
    };
    emitRunEvent(ctx, { kind: "run_start" });
    const claudeBegun = await beginStep(ctx, claudeStep);
    const claude = await executeStep({
      ...claudeBegun.brief,
      bind: false,
      claudeBin: [process.execPath, fakeClaude],
      onSession: workerSessionAnnouncer(ctx, claudeStep, claudeBegun.attempt),
    });
    expect(claude.ok).toBe(true);
    emitRunEvent(ctx, { task: 1, kind: "worker_done", attempt: 1, limit: 2, cost: 0.01 });
    emitRunEvent(ctx, { task: 1, kind: "review", attempt: 1, limit: 2, counts: { high: 0, medium: 0 } });
    emitRunEvent(ctx, { task: 1, kind: "verify", attempt: 1, limit: 2, ok: true });
    saveAgentConfig({ version: 2, duties: { worker: { provider: "openai", model: "gpt-5.6-terra", role: "worker" } } });
    const codexBegun = await beginStep(ctx, codexStep);
    const codex = await executeStep({
      ...codexBegun.brief,
      bind: false,
      codexBin: [process.execPath, fakeCodex],
      onSession: workerSessionAnnouncer(ctx, codexStep, codexBegun.attempt),
    });
    expect(codex.ok).toBe(true);
    emitRunEvent(ctx, { task: 2, kind: "worker_done", attempt: 1, limit: 2, cost: 0.002 });
    emitRunEvent(ctx, { task: 2, kind: "verify", attempt: 1, limit: 2, ok: false });
    emitRunEvent(ctx, { task: 2, kind: "park", attempt: 1, limit: 2, park_kind: "retry", reason: "verify failed" });
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
    expect(formatRunEvent(sessions[1])).toBe(`c#98 t#2 attempt 1/-: worker session codex ${CODEX_THREAD}`);
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
      out.ts = new Date(Date.UTC(2026, 9, 12, 10, 0, i)).toISOString();
      return JSON.stringify(out);
    });
    const parsed = lines.map((line) => JSON.parse(line));
    parsed.filter((event) => event.kind === "worker_session").forEach((event) => expectWorkerSession(event, { local: false }));
    expect(parsed.filter((event) => event.kind === "worker_session").map((event) => event.transcript)).toEqual([
      `${CONTRACT_HOME}\\.claude\\projects\\${slug(`${CONTRACT_HOME}\\work`)}\\${CLAUDE_SESSION}.jsonl`,
      `${CONTRACT_HOME}\\.codex\\sessions\\2026\\10\\12\\rollout-2026-10-12T10-00-00-${CODEX_THREAD}.jsonl`,
    ]);
    mkdirSync(path.dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, `${lines.join("\n")}\n`);
    expect(readFileSync(FIXTURE, "utf8")).not.toContain(path.basename(tmp));
  });
});
