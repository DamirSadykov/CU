import { spawn } from "node:child_process";
import { getProvider, providerCost } from "./providers.mjs";
import { resolveSpawn } from "./engine.mjs";

function capture(file, args, { cwd, env, input, timeoutMs = 90_000, onStdout } = {}) {
  return new Promise((resolve) => {
    const target = resolveSpawn(file, args);
    const child = spawn(target.file, target.args, { ...target.opts, cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false, timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : null;
    child.stdout.on("data", (chunk) => { stdout += chunk; onStdout?.(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
    child.stdin.end(String(input ?? ""));
    function finish(code, error) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, error, stdout, stderr, timedOut });
    }
  });
}

export class Candidate {
  constructor(profile) {
    this.provider = getProvider(profile);
    this.model = String(profile?.model || "").trim();
    this.reasoning_effort = String(profile?.reasoning_effort || "").trim();
    this.profile = Object.freeze({ ...profile, provider: this.provider.id, model: this.model });
    Object.freeze(this);
  }
  argv(options = {}) { return this.provider.engine.argv(this.profile, options); }
  check(options = {}) {
    const binary = this.provider.engine.available(options);
    const guard = this.provider.engine.guard(options);
    return { ok: binary.available, provider: this.provider.id, model: this.model || null, engine: this.provider.engine.id, binary, guard };
  }
  async run(call = {}) {
    const engine = this.provider.engine;
    const guardCheck = engine.guard(call);
    const { file, args } = this.argv(call);
    const onStdout = typeof call.onSession === "function" ? engine.observe(call.onSession) : undefined;
    // An explicit environment is authoritative. In particular the runner uses
    // envWithoutSession() so a child cannot inherit the launching interactive
    // session id; merging process.env back here would silently undo that.
    const baseEnv = call.env === undefined ? process.env : call.env;
    const env = { ...baseEnv, TRACKER_DUTY: call.role || call.duty || "worker", TRACKER_SESSION_KIND: "runner" };
    let run;
    try { run = await (call.spawn || capture)(file, args, { ...call, input: call.prompt ?? call.input, env, onStdout }); }
    catch (error) { run = { code: null, error, stdout: "", stderr: "", timedOut: false }; }
    const parsed = engine.parse(run.stdout);
    const error = run.error || parsed?.error || (run.code !== 0 ? String(run.stderr || `exit ${run.code}`) : "")
      || (!parsed ? `${engine.id} produced no parseable result` : "");
    return {
      provider: this.provider.id, model: this.model || null, engine: engine.id,
      sessionId: parsed?.sessionId || "", answer: parsed?.answer || "", usage: parsed?.usage || null,
      costUsd: providerCost(this.provider.id, this.model, parsed?.usage, this.profile, parsed),
      ok: !error, error: error ? String(error.message || error) : "",
      reason: error ? engine.classifyFailure({ ...run, error }) : null,
      timedOut: !!run.timedOut, code: run.code, raw: parsed?.raw || null,
      stderr: String(run.stderr || ""),
      guard: guardCheck.active ? "active" : "absent",
    };
  }
}

export function createCandidate(profile) { return new Candidate(profile); }
export function runCandidate(profile, call) { return createCandidate(profile).run(call); }
