// Global lifecycle routing: each responsibility resolves to one provider/model.
// Tasks never carry model assignments. The configuration lives beside
// todos.json rather than in settings.json so the Tauri settings writer cannot
// race this CLI.

import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { READ_ONLY_TOOLS, resolveSpawn } from "./providers.mjs";
import { dutyModeReader } from "./duty-mode.mjs";
import { appDataFile, writeJsonAtomic } from "../kernel/appdata.mjs";
import { withDataDir } from "../kernel/board-lock.mjs";
import { createCandidate } from "../models/candidate.mjs";
import { cleanCandidate, isValidV5, migrateAgentConfig } from "./migrate.mjs";

export const AGENT_PROVIDER_MANIFEST = JSON.parse(
  readFileSync(new URL("./agent-providers.json", import.meta.url), "utf8"),
);
export const AGENT_CONFIG_VERSION = 5;
export const PROVIDERS = Object.keys(AGENT_PROVIDER_MANIFEST.providers);
export const DUTIES = ["critic", "architect", "worker", "review", "retro"];
export const PROVIDER_MODELS = Object.fromEntries(
  Object.entries(AGENT_PROVIDER_MANIFEST.providers).map(([provider, config]) => [
    provider,
    [...config.models],
  ]),
);
export const PROVIDER_ALIASES = Object.fromEntries(
  Object.entries(AGENT_PROVIDER_MANIFEST.providers).map(([provider, config]) => [
    provider,
    { ...config.aliases },
  ]),
);
export const STARTER_DUTIES = structuredClone(AGENT_PROVIDER_MANIFEST.duties);
// WHO performs a duty, one field per duty, values declared per duty in the
// manifest. `off` — the step does not happen. `session` — the main session does
// the pass itself, spending no second model. `agent` — the configured
// provider/model is called. `always` — the duty is the executor and cannot be
// turned off (worker). Before v4 this lived in two places at once, a `hooks`
// map of booleans plus a separate `criticMode`, which is why nothing could be
// rendered or set uniformly. The single reading of that migration lives in
// duty-mode.mjs, shared with the Vue settings panel.
const dutyMode = dutyModeReader(AGENT_PROVIDER_MANIFEST);
export const DUTY_MODES = Object.fromEntries(DUTIES.map((duty) => [duty, dutyMode.dutyModes(duty)]));
export const dutyModes = dutyMode.dutyModes;
export const starterMode = dutyMode.starterMode;
export const cleanMode = dutyMode.cleanMode;

export function agentsPath(appData) {
  return appDataFile("agents.json", appData);
}

export function agentsBackupPath(appData) {
  return appDataFile("agents.v4.bak.json", appData);
}

export function emptyAgentConfig() {
  return {
    version: AGENT_CONFIG_VERSION,
    duties: structuredClone(STARTER_DUTIES),
    routes: {},
  };
}

export const RISKS = ["high"];

function cleanProfile(value, duty) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = cleanCandidate(value);
  if (!candidate) return null;
  const out = { mode: cleanMode(duty, value.mode) || starterMode(duty), ...candidate };
  for (const key of ["role", "instructions"]) {
    const v = String(value[key] || "").trim();
    if (v) out[key] = v;
  }
  for (const key of ["input_cost_per_million", "cached_input_cost_per_million", "output_cost_per_million"]) {
    const v = Number(value[key]);
    if (Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

export function readAgentConfig(appData) {
  const file = agentsPath(appData);
  if (!existsSync(file)) return emptyAgentConfig();
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  if (isValidV5(raw)) return raw;

  // A malformed v5 is never guessed at. The original v4 snapshot is the last
  // known user-authored configuration and is safe to migrate again.
  if (raw?.version === 5 || raw === undefined) {
    try { raw = JSON.parse(readFileSync(agentsBackupPath(appData), "utf8")); }
    catch { return emptyAgentConfig(); }
  }
  const migrated = migrateAgentConfig(raw);
  const backup = agentsBackupPath(appData);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(backup)) writeJsonAtomic(backup, raw);
  writeJsonAtomic(file, migrated);
  return migrated;
}

export function saveAgentConfig(config, appData) {
  return withDataDir((dir) => {
    const file = path.join(dir, "agents.json");
    mkdirSync(dir, { recursive: true });
    if (existsSync(file) && !existsSync(agentsBackupPath(appData))) {
      try {
        const old = JSON.parse(readFileSync(file, "utf8"));
        if (old?.version < 5) writeJsonAtomic(agentsBackupPath(appData), old);
      } catch {}
    }
    writeJsonAtomic(file, migrateAgentConfig(config));
    return file;
  }, { appData });
}

// The lifecycle chooses the duty; tasks do not carry model assignments. A
// missing worker mapping preserves the historical unpinned Claude executor.
// `enabled` says the step happens at all, `runsAsAgent` that performing it
// spends the configured model — the two differ exactly for a `session` critic.
export function resolveDuty(duty, appData, { risk } = {}) {
  if (!DUTIES.includes(duty)) throw new Error(`unknown model duty "${duty}"`);
  const cfg = readAgentConfig(appData);
  const base = cfg.duties[duty] || {};
  const mode = cleanMode(duty, base.mode) || starterMode(duty);
  const riskKey = String(risk || "").trim().toLowerCase();
  const routeCandidates = RISKS.includes(riskKey) ? cfg.routes?.[riskKey]?.[duty] : null;
  const profiles = (Array.isArray(routeCandidates) && routeCandidates.length ? routeCandidates : base.candidates)
    .map((candidate) => ({ ...base, ...candidate, candidates: undefined }))
    .map((profile) => { delete profile.candidates; return profile; });
  const candidates = profiles.map(createCandidate);
  const primary = candidates[0]?.profile || {};
  const resolved = {
    name: duty,
    duty,
    ...base, ...primary,
    candidates,
    mode,
    enabled: mode !== "off",
    runsAsAgent: mode === "agent" || mode === "always",
  };
  if (!RISKS.includes(riskKey)) return resolved;
  if (!Array.isArray(routeCandidates) || !routeCandidates.length) {
    return { ...resolved, route: { applied: false, risk: riskKey, note: `risk ${riskKey}, invalid or no route configured for ${duty}` } };
  }
  return { ...resolved, route: { applied: true, risk: riskKey, note: `risk ${riskKey} routed ${duty} to ${primary.provider}/${primary.model}` } };
}

// `off` | `session` | `agent`. Callers that inject context ask for the mode; the
// one caller that can spend a model asks whether it runs as an agent.
export function criticMode(appData) {
  return resolveDuty("critic", appData).mode;
}

export function criticRunsAsAgent(appData) {
  return resolveDuty("critic", appData).runsAsAgent;
}

export function checkAgentDuties(appData, {
  duties = DUTIES,
  claudeBin = process.env.CLAUDE_BIN || "claude",
  codexBin = process.env.CODEX_BIN || "codex",
  run,
  settingsPath,
  rulesFile,
} = {}) {
  const results = [];
  for (const duty of duties) {
    const resolved = resolveDuty(duty, appData);
    if (!resolved.runsAsAgent) continue;
    const attempts = resolved.candidates.map((candidate) => candidate.check({
      bin: candidate.provider.engine.id === "codex" ? codexBin : claudeBin,
      run, settingsPath, rulesFile,
    }));
    results.push({ duty, ok: attempts.some((candidate) => candidate.ok), candidates: attempts });
  }
  return { ok: results.every((result) => result.ok), duties: results };
}

export function assertAgentDutiesAvailable(appData, options) {
  const report = checkAgentDuties(appData, options);
  const unavailable = report.duties.filter((duty) => !duty.ok);
  if (unavailable.length) {
    const detail = unavailable.map(({ duty, candidates }) =>
      `${duty}: ${candidates.map((item) => `${item.provider}/${item.model} (${item.binary.reason || "missing"})`).join(", ")}`,
    ).join("; ");
    throw new Error(`no available candidate for enabled duties — ${detail}`);
  }
  return report;
}

export function buildDutyPrompt(profile, prompt) {
  return [profile?.instructions, prompt].filter(Boolean).join("\n\n");
}

// Hook-safe, bounded role call. Failures are returned to the hook, whose policy
// decides whether to fail open; credentials come from the provider CLI itself.
export function invokeDutySync(duty, prompt, {
  cwd = process.cwd(), timeoutMs = 90_000,
  appData,
  addDirs = [],
  claudeBin = process.env.CLAUDE_BIN || "claude",
  codexBin = process.env.CODEX_BIN || "codex",
} = {}) {
  const p = resolveDuty(duty, appData);
  if (!p.runsAsAgent || !p.model) return { skipped: true, ok: true, text: "", profile: p };
  const fallback = [];
  for (const candidate of p.candidates) {
    const bin = candidate.provider.id === "openai" ? codexBin : claudeBin;
    const options = { bin, sandbox: "read-only", allowedTools: READ_ONLY_TOOLS, addDirs };
    const available = candidate.check(options);
    if (!available.ok) {
      fallback.push({ provider: candidate.provider.id, model: candidate.model, reason: "missing" });
      continue;
    }
    const { file, args } = candidate.argv(options);
    const fullPrompt = buildDutyPrompt({ ...p, ...candidate.profile }, prompt);
    const target = resolveSpawn(file, args);
    const run = spawnSync(target.file, target.args, {
      ...target.opts,
      cwd, input: String(fullPrompt), encoding: "utf8", windowsHide: true,
      timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TRACKER_DUTY: p.role || duty, TRACKER_SESSION_KIND: "runner" },
    });
    const parsed = candidate.provider.engine.parse(run.stdout);
    const text = String(parsed?.answer || "");
    const error = run.error?.message || parsed?.error || (run.status !== 0 ? String(run.stderr || `exit ${run.status}`) : "") || (!text ? `${candidate.provider.engine.id} returned no answer` : "");
    if (!error) return { ok: true, error: "", text, profile: { ...p, ...candidate.profile }, fallback };
    const reason = candidate.provider.engine.classifyFailure({ error: run.error || error, stderr: run.stderr, stdout: run.stdout, code: run.status, timedOut: run.error?.code === "ETIMEDOUT" });
    if (!["missing", "auth", "limit"].includes(reason))
      return { ok: false, error, text: "", profile: { ...p, ...candidate.profile }, fallback, failureReason: reason };
    fallback.push({ provider: candidate.provider.id, model: candidate.model, reason });
  }
  return { ok: false, error: `candidates_exhausted: ${fallback.map((item) => `${item.provider}/${item.model} (${item.reason})`).join(", ")}`, text: "", profile: p, fallback, failureReason: "candidates_exhausted" };
}

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) positional.push(a);
    else {
      const key = a.slice(2);
      const next = args[i + 1];
      flags[key] = next === undefined || next.startsWith("--") ? true : next;
      if (flags[key] !== true) i++;
    }
  }
  return { positional, flags };
}

function fail(message) {
  throw new Error(message);
}

function cmdInit(args) {
  const { flags } = parseFlags(args);
  if (existsSync(agentsPath()) && !flags.force)
    fail("agents.json already has a duty map; pass --force to replace it with the starter set");
  const config = emptyAgentConfig();
  const file = saveAgentConfig(config);
  process.stdout.write(`ok: wrote ${Object.keys(config.duties).length} duty mappings -> ${file}\n`);
}

function cmdSet(args) {
  const { positional, flags } = parseFlags(args);
  const name = String(positional[0] || "").trim().toLowerCase();
  if (!DUTIES.includes(name)) fail(`usage: cli agents set <${DUTIES.join("|")}> --provider anthropic|openai --model <id>`);
  const cfg = readAgentConfig();
  const before = cfg.duties[name] || {};
  const first = before.candidates?.[0] || {};
  const candidate = {
    ...first,
    ...(flags.mode ? { mode: flags.mode } : {}),
    ...(flags.provider ? { provider: flags.provider } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.role ? { role: flags.role } : {}),
    ...(flags.instructions ? { instructions: flags.instructions } : {}),
    ...(flags.reasoning ? { reasoning_effort: flags.reasoning } : {}),
  };
  if (flags.mode && !cleanMode(name, flags.mode))
    fail(`${name} takes mode ${dutyModes(name).join(" | ")}`);
  const profile = cleanProfile(candidate, name);
  if (!profile) fail(`model does not belong to provider (anthropic: ${PROVIDER_MODELS.anthropic.join(", ")}; openai: ${PROVIDER_MODELS.openai.join(", ")})`);
  cfg.duties[name] = {
    ...before,
    mode: profile.mode,
    ...(profile.role ? { role: profile.role } : {}),
    ...(profile.instructions ? { instructions: profile.instructions } : {}),
    candidates: [
      Object.fromEntries(Object.entries(profile).filter(([key]) => !["mode", "role", "instructions"].includes(key))),
      ...(before.candidates || []).slice(1),
    ],
  };
  saveAgentConfig(cfg);
  process.stdout.write(`ok: ${name} [${profile.mode}] -> ${profile.provider}/${profile.model}\n`);
}

function setMode(duty, value) {
  const name = String(duty || "").trim().toLowerCase();
  if (!DUTIES.includes(name)) fail(`usage: cli agents mode <${DUTIES.join("|")}> <value>`);
  const mode = cleanMode(name, value);
  if (!mode) fail(`${name} takes mode ${dutyModes(name).join(" | ")}`);
  const cfg = readAgentConfig();
  cfg.duties[name].mode = mode;
  saveAgentConfig(cfg);
  process.stdout.write(`ok: ${name} -> ${mode}\n`);
}

function cmdMode(args) {
  setMode(args[0], args[1]);
}

// The v3 spelling, kept because it is in muscle memory and in older notes.
function cmdHook(args) {
  const state = String(args[1] || "").trim().toLowerCase();
  if (!["on", "off"].includes(state))
    fail("usage: cli agents hook <critic|architect|review> <on|off>");
  const duty = String(args[0] || "").trim().toLowerCase();
  const on = duty === "critic" ? "session" : "agent";
  setMode(duty, state === "on" ? on : "off");
}

function cmdCriticMode(args) {
  setMode("critic", args[0]);
}

function cmdList(json = false) {
  const cfg = readAgentConfig();
  if (json) return process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
  for (const name of DUTIES) {
    const p = cfg.duties[name];
    if (!p) continue;
    process.stdout.write(
      `${name.padEnd(10)} ${String(p.mode).padEnd(8)} ${(p.candidates || []).map((candidate) => `${candidate.provider}/${candidate.model}`).join(" -> ")}\n`,
    );
  }
}

function cmdCheck(args) {
  const { flags } = parseFlags(args);
  const report = checkAgentDuties();
  if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else for (const item of report.duties) {
    process.stdout.write(`${item.ok ? "ok" : "missing"}: ${item.duty} — ${item.candidates.map((candidate) => `${candidate.provider}/${candidate.model}:${candidate.binary.available ? "available" : candidate.binary.reason},guard:${candidate.guard.active ? "active" : "absent"}`).join("; ")}\n`);
  }
  if (!report.ok) fail("one or more enabled duties have no available candidate");
}

function usage() {
  process.stdout.write(
    "cli agents - lifecycle duty -> provider/model map\n\n" +
      "  init [--force]\n" +
      "  list [--json]\n" +
      "  check [--json]   verify engine binaries and guards before a run\n" +
      `  set <${DUTIES.join("|")}> --provider anthropic|openai --model <id> [--mode <value>]\n` +
      "             [--role <name>] [--instructions <text>] [--reasoning <level>]\n" +
      `  mode <duty> <value>   who performs the duty — ${DUTIES.map((d) => `${d}: ${dutyModes(d).join("|")}`).join("; ")}\n` +
      "  hook <critic|architect|review> <on|off>   the v3 spelling of `mode`\n" +
      "  critic-mode <session|agent>               the v3 spelling of `mode critic`\n" +
      "  path\n\n" +
      "The lifecycle selects the duty; individual tasks do not select models.\n",
  );
}

export function run(args) {
  const [cmd, ...rest] = args;
  if (cmd === "init") return cmdInit(rest);
  if (cmd === "set") return cmdSet(rest);
  if (cmd === "mode") return cmdMode(rest);
  if (cmd === "hook") return cmdHook(rest);
  if (cmd === "critic-mode") return cmdCriticMode(rest);
  if (cmd === "list") return cmdList(rest.includes("--json"));
  if (cmd === "check") return cmdCheck(rest);
  if (cmd === "path") return process.stdout.write(agentsPath() + "\n");
  if (cmd === undefined || ["help", "-h", "--help"].includes(cmd)) return usage();
  fail(`unknown agents command: ${cmd}`);
}
