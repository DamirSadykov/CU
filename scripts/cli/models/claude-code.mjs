import { assertSandbox, createEngine, splitBin } from "./engine.mjs";
import { readFileSync } from "node:fs";
import { claudeGuardSettings } from "../guard/guard.mjs";
import { GUARDED_TOOLS } from "../guard/policy.mjs";

function needsWriteGuard(sandbox, allowedTools) {
  return sandbox === "workspace-write" || (allowedTools || []).some((tool) => GUARDED_TOOLS.includes(tool));
}

function parseSettings(value) {
  const source = String(value || "").trim();
  if (!source) return {};
  const raw = source.startsWith("{") ? source : readFileSync(source, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Claude settings must be a JSON object");
  return parsed;
}

function currentGuardHook() {
  return JSON.parse(claudeGuardSettings()).hooks.PreToolUse[0];
}

function sameGuardHook(candidate, expected = currentGuardHook()) {
  return candidate?.matcher === expected.matcher
    && Array.isArray(candidate?.hooks)
    && candidate.hooks.some((hook) => hook?.type === "command" && hook.command === expected.hooks[0].command);
}

export function hasClaudeGuard(settingsValue) {
  try {
    const settings = parseSettings(settingsValue);
    return Array.isArray(settings?.hooks?.PreToolUse)
      && settings.hooks.PreToolUse.some((hook) => sameGuardHook(hook));
  } catch {
    return false;
  }
}

export function claudeRunnerSettings({ settingsPath = "", settings = "", sandbox = "read-only", allowedTools = READ_ONLY_TOOLS } = {}) {
  const supplied = settingsPath || settings;
  if (!needsWriteGuard(sandbox, allowedTools)) return supplied;
  const parsed = parseSettings(supplied);
  const guardHook = currentGuardHook();
  const hooks = parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks) ? parsed.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  return JSON.stringify({
    ...parsed,
    hooks: {
      ...hooks,
      PreToolUse: preToolUse.some((hook) => sameGuardHook(hook, guardHook)) ? preToolUse : [...preToolUse, guardHook],
    },
  });
}

export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
export const CLAUDE_SETTING_SOURCES = "project";

export function claudeCodeArgv(profile = {}, {
  bin = "claude", session = "", inherit = "", sandbox = "read-only",
  allowedTools = READ_ONLY_TOOLS, permissionMode = "acceptEdits", addDirs = [],
  settingsPath = "", settings = "",
} = {}) {
  assertSandbox(sandbox);
  const { file, prefix } = splitBin(bin);
  const args = [...prefix, "-p"];
  if (inherit) args.push("--resume", inherit, "--fork-session");
  else if (session) args.push("--session-id", session);
  args.push("--output-format", "json", "--permission-mode", permissionMode);
  args.push("--setting-sources", CLAUDE_SETTING_SOURCES);
  const runnerSettings = claudeRunnerSettings({ settingsPath, settings, sandbox, allowedTools });
  if (runnerSettings) args.push("--settings", runnerSettings);
  const dirs = [...new Set((Array.isArray(addDirs) ? addDirs : [addDirs]).map((v) => String(v || "").trim()).filter(Boolean))];
  if (dirs.length) args.push("--add-dir", ...dirs);
  if (allowedTools?.length) args.push("--allowedTools", ...allowedTools);
  const model = String(profile.model || "").trim();
  if (model) args.push("--model", model);
  return { file, args };
}

export function parseClaudeResult(stdout) {
  const source = String(stdout ?? "").trim();
  if (!source) return null;
  let raw;
  try { raw = JSON.parse(source); } catch {}
  if (!raw || typeof raw !== "object") {
    for (const line of source.split("\n").reverse()) {
      if (!line.trim().startsWith("{")) continue;
      try { raw = JSON.parse(line); } catch { continue; }
      if (raw && typeof raw === "object") break;
    }
  }
  return raw && typeof raw === "object" ? raw : null;
}

export function normalizeClaudeResult(stdout) {
  const raw = parseClaudeResult(stdout);
  if (!raw) return null;
  return {
    sessionId: typeof raw.session_id === "string" ? raw.session_id.trim() : "",
    answer: typeof raw.result === "string" ? raw.result : "",
    usage: raw.usage || null,
    error: raw.is_error ? "the model reported an error" : "",
    costUsd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : null,
    raw,
  };
}

export const CLAUDE_CODE_ENGINE = createEngine({
  id: "claude-code",
  binary: "claude",
  argv: claudeCodeArgv,
  parse: normalizeClaudeResult,
  guard: ({ settingsPath = "", settings = "", sandbox = "read-only", allowedTools = READ_ONLY_TOOLS } = {}) => {
    let runnerSettings = settingsPath || settings;
    try { runnerSettings = claudeRunnerSettings({ settingsPath, settings, sandbox, allowedTools }); }
    catch (error) { return { active: false, reason: `Claude runner settings are invalid: ${error.message}` }; }
    const active = hasClaudeGuard(runnerSettings);
    return {
      active,
      reason: active ? null : "CU PreToolUse guard is absent from Claude runner settings",
    };
  },
});

export default CLAUDE_CODE_ENGINE;
